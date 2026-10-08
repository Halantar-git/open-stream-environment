# Логотип темы Wardogs

`logo.png` — эмблема игры WARDOGS (щит с волком), взята из официальных
community-ассетов Steam:

`https://shared.fastly.steamstatic.com/community_assets/images/apps/4809930/6829090332535af8637c4b6e1dddf3ee8ec3d134.ico`

Исходник (`.ico`) переведён в PNG 256×256 с прозрачным фоном. Логотип —
собственность Bulkhead/Team17 и используется как элемент оформления темы.

Файл отдаётся сервером по пути `/assets/themes/wardogs/logo.png` и рисуется на
гранях виджета «Куб Wardogs» (`overlay/widgets/wardogs-cube-widget.js`):
чёрная часть эмблемы перекрашивается в акцент темы, белая остаётся белой.
