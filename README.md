# TraubenScan Rheinhessen

[![In GitHub Codespaces öffnen](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new?hide_repo_select=true&repo=dlinzner-bcs%2FChardonAI&ref=main)

Eine mobil optimierte, installierbare Web-App für die private lokale Analyse von Traubenbildern. Foto aufnehmen oder auswählen, einzelne Beeren erkennen, interaktive Segmentierung prüfen und visuelle Schätzwerte ansehen.

## Auf dem Smartphone testen

Für den Smartphone-Test die Codespaces-Schaltfläche oben verwenden. Nach dem Start installiert Codespaces die Python-Abhängigkeiten, startet den Node-/OpenCV-Server und veröffentlicht Port `4173`. Die öffentliche Port-URL kann direkt am Smartphone geöffnet werden. Alternativ lässt sich derselbe Server über das enthaltene `Dockerfile` betreiben.

## Lokal starten

```sh
npm start
```

Danach `http://localhost:4173` öffnen. Auf einem echten Smartphone muss die App über HTTPS (oder localhost) bereitgestellt werden, damit der Kamerazugriff verfügbar ist.

## Analysemodell

Bildpixel werden in HSV umgerechnet, eine Maske für typische Traubenfarben wird per zusammenhängender Regionen verfeinert und ein lokaler Zentrumdetektor trennt einzelne Beeren. Jede erkannte Beere wird nach relativem Durchmesser, Farbgleichmäßigkeit, Helligkeit und visuellem Qualitätswert bewertet. Das Ergebnis ist bewusst als visuelle Schätzung gekennzeichnet: Es ersetzt keine Labormessung und benötigt für kalibrierte Größen eine reale Referenz.

Die gesamte Bildverarbeitung findet im Browser statt; Fotos werden nicht hochgeladen.

## Klassische Computer-Vision-Pipeline

Für einen reproduzierbaren Server- oder Batch-Versuch liegt mit `segment_grapes.py` eine klassische OpenCV-Pipeline bereit. Sie kombiniert HSV-Farbsegmentierung, Morphologie, Distance Transform und Marker-basiertes Watershed, verwirft isolierte Hintergrundregionen und berechnet Flächen-, Rundheits- und Konfidenzwerte.

```sh
python -m pip install -r requirements.txt
python segment_grapes.py trauben.jpg \
  --overlay trauben_segmentiert.jpg \
  --json trauben_analyse.json
```

Für das mitgelieferte Bild erzeugt die verbesserte Hough-/Watershed-Pipeline aktuell 43 markierte Beeren. Die größte zusammenhängende Traubenregion wird bevorzugt, Hough-Kreise liefern robuste Marker und Morphologie stabilisiert die Segmente. Die Pixelgrößen sind ohne Maßstabsreferenz nur relative Messwerte.
