# Аудио приложения

Звуковые файлы (лежат здесь, отдаются локальным сервером по пути
`/assets/audio/...`):

- `wheel-spin.mp3` — звук вращения барабана, ~5.3 с. Проигрывается один раз за
  цикл; длительность вращения колеса подогнана под него.
- `win.wav` — джингл победы, ~2.6 с.
- `elimination.wav` — джингл выбывания («проигрыш»), ~2.9 с.
- `buzzer.wav` — сигнал уведомлений о событиях (фоллоу/подписки/донаты).

Если файл отсутствует или не декодируется, оверлей автоматически использует
встроенные Web Audio-звуки (сгенерированные осцилляторами), поэтому приложение
продолжает работать без них.

## Источники и лицензии

Все звуки — свободные материалы с [Freesound.org](https://freesound.org).
Это не «бесплатно без условий»: `wheel-spin.mp3`, `win.wav` и `elimination.wav`
под **Creative Commons Attribution (CC BY)** — их можно свободно использовать, в
том числе в коммерческих стримах и записях, при условии указания автора
(атрибуция ниже). `buzzer.wav` — **CC0**, без условий.

- `wheel-spin.mp3` — «Wheel Spin sound», автор
  [roulettevision](https://freesound.org/people/roulettevision/),
  [звук 420891](https://freesound.org/people/roulettevision/sounds/420891/),
  **CC BY 3.0**.
- `win.wav` — «Jingle_Win_00», автор
  [LittleRobotSoundFactory](https://freesound.org/people/LittleRobotSoundFactory/),
  [звук 270333](https://freesound.org/people/LittleRobotSoundFactory/sounds/270333/),
  **CC BY 4.0**.
- `elimination.wav` — «Jingle_Lose_01», автор
  [LittleRobotSoundFactory](https://freesound.org/people/LittleRobotSoundFactory/),
  [звук 270334](https://freesound.org/people/LittleRobotSoundFactory/sounds/270334/),
  **CC BY 4.0**.
- `buzzer.wav` — автор
  [Garuda1982](https://freesound.org/people/Garuda1982/), **CC0**.
