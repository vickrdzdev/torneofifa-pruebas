> **Sitio de pruebas.** Este repo es una copia de [vickrdzdev/torneofifa](https://github.com/vickrdzdev/torneofifa) para probar cambios antes de publicarlos en torneofifa.com. Aquí la app usa siempre la base de datos de pruebas.

# Torneo FC27 — Liga entre amigos

App de una sola página (`index.html`) para llevar el torneo de FIFA/FC27 en PlayStation:
12 Jornadas, tabla de posiciones, desempate "Leagues Cup" por penales y Liguilla automática.

Los datos viven en Supabase (lectura pública en vivo, escritura solo para el admin autenticado).
No requiere build ni dependencias — es HTML/CSS/JS puro, se despliega tal cual en cualquier
hosting estático (Netlify, Vercel, Cloudflare Pages, GitHub Pages).

## Configuración

La URL y la llave pública (`publishable key`) de Supabase están en `index.html`. La llave
pública es segura de exponer: todo el control de acceso real vive en las políticas de RLS
de la base de datos (lectura pública, escritura solo para usuarios autenticados).

El usuario admin se crea desde el dashboard de Supabase → Authentication → Users.

## Mercado

`market.json` contiene el mercado de jugadores (Futbin FC27), generado a partir del Excel
`Futbin_FC27.xlsx`: se omiten columnas vacías y la duplicada `NAME AUX`, y se unifican las
cartas repetidas del mismo jugador. Las compras se guardan en la tabla `team_purchases`
de Supabase (una fila por jugador comprado, con el valor pagado).

## Base de pruebas

La app usa la base real (`torneofifa`) solo en torneofifa.com, www.torneofifa.com y
torneofifateam.netlify.app. En cualquier otra dirección (GitHub Pages, copias locales) usa
la base de pruebas `torneofifa-pruebas` y muestra una franja "MODO PRUEBAS". Ambas bases
tienen la misma estructura; los usuarios admin se dan de alta por separado en cada una.

