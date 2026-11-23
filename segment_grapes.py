#!/usr/bin/env python3
"""Segment individual grape berries with color filtering and marker watershed."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass(frozen=True)
class Berry:
    id: int
    x: int
    y: int
    radius_px: float
    area_px: float
    circularity: float
    confidence: float
    mean_bgr: tuple[int, int, int]


def grape_color_mask(image: np.ndarray) -> np.ndarray:
    """Build a conservative mask for blue-black and purple grape surfaces."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hue, saturation, value = cv2.split(hsv)
    blue, green, red = cv2.split(image)

    grape_hue = (hue >= 82) & (hue <= 137)
    saturated = saturation >= 42
    dark_enough = (value >= 18) & (value <= 190)
    blue_dominant = blue.astype(np.int16) > red.astype(np.int16) - 10
    low_warmth = green.astype(np.int16) >= red.astype(np.int16) - 8
    mask = (grape_hue & saturated & dark_enough & blue_dominant & low_warmth).astype(np.uint8) * 255

    mask = cv2.medianBlur(mask, 5)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    return mask


def remove_small_regions(mask: np.ndarray, minimum_area: int) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    cleaned = np.zeros_like(mask)
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] >= minimum_area:
            cleaned[labels == label] = 255
    return cleaned


def keep_main_cluster(mask: np.ndarray) -> np.ndarray:
    """Discard isolated background shadows and keep detached grapes near the main bunch."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return mask
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    kept = np.zeros_like(mask)
    kept[labels == largest] = 255
    return kept


def hough_berry_centers(image: np.ndarray, mask: np.ndarray) -> list[tuple[float, float, float]]:
    """Find near-circular berries, keeping candidates supported by the grape mask."""
    short_side = min(mask.shape)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 1.2)
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.1,
        minDist=max(8, round(short_side * 0.029)),
        param1=65,
        param2=20,
        minRadius=max(5, round(short_side * 0.017)),
        maxRadius=max(12, round(short_side * 0.062)),
    )
    if circles is None:
        return []

    accepted: list[tuple[float, float, float]] = []
    for x, y, radius in circles[0]:
        x, y, radius = float(x), float(y), float(radius)
        circle = np.zeros_like(mask)
        cv2.circle(circle, (round(x), round(y)), round(radius), 255, -1)
        support = cv2.mean(mask, mask=circle)[0] / 255
        center_support = mask[round(y), round(x)] > 0 if 0 <= round(y) < mask.shape[0] and 0 <= round(x) < mask.shape[1] else False
        if support >= 0.22 and (center_support or support >= 0.5):
            if all(np.hypot(x - old_x, y - old_y) >= max(6, min(radius, old_radius) * 0.72) for old_x, old_y, old_radius in accepted):
                accepted.append((x, y, radius))
    return accepted


def hough_watershed(image: np.ndarray, mask: np.ndarray, centers: list[tuple[float, float, float]]) -> tuple[np.ndarray, int]:
    """Use Hough circle centers as strong markers for watershed boundaries."""
    if not centers:
        return np.zeros_like(mask, dtype=np.int32), 0
    markers = np.zeros(mask.shape, dtype=np.int32)
    markers[mask == 0] = 1
    for label, (x, y, radius) in enumerate(centers, 2):
        seed_radius = max(1, min(4, round(radius * 0.18)))
        cv2.circle(markers, (round(x), round(y)), seed_radius, label, -1)
    labels = cv2.watershed(cv2.GaussianBlur(image, (5, 5), 0), markers)
    return labels, len(centers)


def watershed_labels(image: np.ndarray, mask: np.ndarray, scale: float) -> tuple[np.ndarray, int]:
    """Create one marker per likely berry center and separate touching berries."""
    distance = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    maximum = distance.max()
    if maximum == 0:
        return np.zeros_like(mask, dtype=np.int32), 0

    smooth_distance = cv2.GaussianBlur(distance, (0, 0), max(1.0, 1.2 * scale))
    kernel_size = max(3, round(5 * scale) | 1)
    local_max = cv2.dilate(smooth_distance, np.ones((kernel_size, kernel_size), np.uint8))
    peaks = (np.isclose(smooth_distance, local_max, rtol=0, atol=1e-3)) & (smooth_distance >= maximum * 0.23)
    peaks = peaks.astype(np.uint8) * 255
    peaks = cv2.morphologyEx(peaks, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    marker_count, markers = cv2.connectedComponents(peaks)

    markers = np.where(markers > 0, markers + 1, 0).astype(np.int32)
    markers[mask == 0] = 1
    blurred = cv2.GaussianBlur(image, (5, 5), 0)
    labels = cv2.watershed(blurred, markers)
    return labels, marker_count - 1


def measure_hough_berries(image: np.ndarray, mask: np.ndarray, centers: list[tuple[float, float, float]]) -> list[Berry]:
    """Measure circular Hough segments without losing valid markers to watershed rules."""
    measurements: list[Berry] = []
    for x, y, radius in centers:
        region = np.zeros_like(mask)
        cv2.circle(region, (round(x), round(y)), round(radius), 255, -1)
        grape_region = region & mask
        area = float(cv2.countNonZero(grape_region))
        full_area = max(1.0, np.pi * radius * radius)
        fill_ratio = min(1.0, area / full_area)
        edge_ring = np.zeros_like(mask)
        cv2.circle(edge_ring, (round(x), round(y)), round(radius), 255, max(1, round(radius * 0.2)))
        edge_support = cv2.mean(mask, mask=edge_ring)[0] / 255
        confidence = 100 * (0.72 * fill_ratio + 0.28 * edge_support)
        pixels = image[grape_region > 0]
        if pixels.size == 0:
            continue
        mean_bgr = tuple(int(value) for value in np.median(pixels, axis=0))
        measurements.append(Berry(0, round(x), round(y), round(radius, 2), area, round(float(fill_ratio), 3), round(float(np.clip(confidence, 0, 100)), 1), mean_bgr))
    measurements.sort(key=lambda berry: (berry.y, berry.x))
    return [Berry(index, b.x, b.y, b.radius_px, b.area_px, b.circularity, b.confidence, b.mean_bgr) for index, b in enumerate(measurements, 1)]


def measure_berries(image: np.ndarray, labels: np.ndarray, mask: np.ndarray) -> list[Berry]:
    height, width = mask.shape
    image_area = height * width
    measurements: list[Berry] = []
    minimum_area = max(55, int(image_area * 0.00016))
    maximum_area = max(1500, int(image_area * 0.045))

    for label in np.unique(labels):
        if label <= 1:
            continue
        region = np.uint8((labels == label) & (mask > 0)) * 255
        area = int(cv2.countNonZero(region))
        if not minimum_area <= area <= maximum_area:
            continue
        contours, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(contour, True)
        if perimeter == 0:
            continue
        (x, y), radius = cv2.minEnclosingCircle(contour)
        circularity = float(min(1.0, 4 * np.pi * area / (perimeter * perimeter)))
        fill_ratio = area / max(1.0, np.pi * radius * radius)
        if radius < 5 or radius > min(height, width) * 0.17 or fill_ratio < 0.32:
            continue
        pixels = image[region > 0]
        confidence = float(np.clip((circularity * 0.6 + fill_ratio * 0.4) * 100, 0, 100))
        mean_bgr = tuple(int(value) for value in np.median(pixels, axis=0))
        measurements.append(Berry(0, round(x), round(y), round(float(radius), 2), float(area), round(circularity, 3), round(confidence, 1), mean_bgr))

    measurements.sort(key=lambda berry: (berry.y, berry.x))
    return [Berry(index, b.x, b.y, b.radius_px, b.area_px, b.circularity, b.confidence, b.mean_bgr) for index, b in enumerate(measurements, 1)]


def draw_overlay(image: np.ndarray, berries: list[Berry]) -> np.ndarray:
    overlay = image.copy()
    for berry in berries:
        quality = berry.confidence
        color = (70, 205, 110) if quality >= 72 else (50, 185, 230) if quality >= 52 else (75, 95, 235)
        cv2.circle(overlay, (berry.x, berry.y), max(2, round(berry.radius_px)), color, 2)
        cv2.circle(overlay, (berry.x, berry.y), 2, color, -1)
        label = str(berry.id)
        size = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.42, 1)[0]
        text_x, text_y = berry.x - size[0] // 2, berry.y - round(berry.radius_px) - 6
        cv2.putText(overlay, label, (text_x, max(12, text_y)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (250, 250, 250), 2, cv2.LINE_AA)
        cv2.putText(overlay, label, (text_x, max(12, text_y)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, color, 1, cv2.LINE_AA)
    return overlay


def segment(image_path: Path) -> tuple[np.ndarray, list[Berry], np.ndarray, int]:
    source = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if source is None:
        raise ValueError(f"Bild konnte nicht geöffnet werden: {image_path}")

    maximum_side = 1000
    scale = min(1.0, maximum_side / max(source.shape[:2]))
    if scale < 1.0:
        image = cv2.resize(source, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    else:
        image = source

    softened = cv2.bilateralFilter(image, 7, 45, 45)
    mask = grape_color_mask(softened)
    mask = remove_small_regions(mask, max(55, round(scale * scale * image.shape[0] * image.shape[1] * 0.00013)))
    mask = keep_main_cluster(mask)
    hough_centers = hough_berry_centers(image, mask)
    if len(hough_centers) >= 3:
        marker_count = len(hough_centers)
        berries = measure_hough_berries(image, mask, hough_centers)
    else:
        labels, marker_count = watershed_labels(image, mask, max(1.0, scale))
        berries = measure_berries(image, labels, mask)
    overlay = draw_overlay(image, berries)

    if scale < 1.0:
        overlay = cv2.resize(overlay, source.shape[1::-1], interpolation=cv2.INTER_LINEAR)
    return overlay, berries, mask, marker_count


def main() -> None:
    parser = argparse.ArgumentParser(description="Segmentiert einzelne Weintrauben mit klassischer Computer Vision.")
    parser.add_argument("image", type=Path, help="Pfad zum Eingabebild")
    parser.add_argument("--overlay", type=Path, default=Path("trauben_segmentiert.jpg"), help="Ausgabepfad des Overlay-Bilds")
    parser.add_argument("--json", type=Path, default=Path("trauben_analyse.json"), help="Ausgabepfad der Messwerte")
    args = parser.parse_args()

    overlay, berries, mask, marker_count = segment(args.image)
    args.overlay.parent.mkdir(parents=True, exist_ok=True)
    args.json.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(args.overlay), overlay)

    diameters = [berry.radius_px * 2 for berry in berries]
    result = {
        "image": str(args.image),
        "berry_count": len(berries),
        "detector_markers": marker_count,
        "mean_diameter_px": round(float(np.mean(diameters)), 2) if diameters else 0,
        "diameter_std_px": round(float(np.std(diameters)), 2) if diameters else 0,
        "mask_coverage_percent": round(float(np.mean(mask > 0) * 100), 2),
        "berries": [asdict(berry) for berry in berries],
    }
    args.json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key != "berries"}, ensure_ascii=False, indent=2))
    print(f"Overlay: {args.overlay}\nMesswerte: {args.json}")


if __name__ == "__main__":
    main()
