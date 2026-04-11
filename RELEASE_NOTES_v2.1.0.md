## MyFTB Launcher v2.1.0

### 🚀 Neue Features

- **Speicherort für Modpacks** — Der Speicherort kann jetzt in den Einstellungen geändert werden. Bestehende Modpack-Instanzen werden dabei automatisch verschoben.
- **Pack-spezifische Einstellungen** — RAM und JVM-Argumente können jetzt pro Modpack individuell angepasst werden.
- **Explizite Update-Aktion** — Veraltete Modpacks zeigen einen eigenen Update-Button, der nicht mehr direkt das Spiel startet.
- **Installationsfortschritt beim Update** — Der Fortschritt wird jetzt auch angezeigt, wenn ein bereits installiertes Pack aktualisiert wird.
- **Minecraft läuft unabhängig** — Minecraft bleibt geöffnet, auch wenn der Launcher geschlossen wird.
- **Textauswahl im Log-Viewer** — Logs können jetzt markiert und kopiert werden.
- **Datei-basiertes Logging** — Umfangreiches Logging aller Services für bessere Fehlerdiagnose.
- **Robustere Downloads** — Neuer Download-Dispatcher mit automatischen Retries und Timeout-Handling.

### 🐛 Fehlerbehebungen

- Minecraft-Prozess überlebt jetzt das Schließen des Launchers (detached process)
- Update-Kanal wechselt jetzt sofort nach Umschalten in den Einstellungen
- "Wird gespielt"-Badge wird korrekt entfernt wenn Minecraft beendet wird
- "Wird gespielt"-Badge bleibt beim Tab-Wechsel erhalten
- Fortschrittsanzeige zeigt Verifizierungsstatus bei langsamen Downloads
- LD_LIBRARY_PATH wird unter Linux korrekt bereinigt
- Rollback bei fehlgeschlagener Verschiebung des Speicherorts korrigiert
- Verbesserte Barrierefreiheit der Titelleisten-Buttons (Fokus-Styles)
- Diverse UI-Verbesserungen (Schriftgrößen, Button-Labels, Umlaute)
- Umfangreicher Code-Audit mit 14+ Bugfixes und Stabilitätsverbesserungen

### ♻️ Verbesserungen

- Codequalität und Testabdeckung deutlich erhöht
- Abhängigkeiten aktualisiert (Electron, TypeScript, Vitest, Discord RPC)
