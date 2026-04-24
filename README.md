# Physics Playground

Mini-juego / simulador de físicas en el navegador. Click para spawnear entidades con distintas formas (una de ellas usa tu foto `jp.png`), teclas para cambiar de tipo, modo gravedad y herramientas de debug. Incluye un chat global en tiempo real vía Supabase.

## Stack

- **Vite 6 + React 19 + TypeScript** — frontend
- **Matter.js** — motor de físicas 2D con sprites
- **Tailwind CSS v4** — estilos
- **Supabase Realtime** — chat global (tier gratuito, ~500 MB y 2M mensajes/mes)

## Controles

Pulsa `?` dentro de la app para ver el panel completo. Resumen:

**Entidades (toca para seleccionar, click para spawnear)**

| Tecla | Entidad  | Tecla | Entidad         |
| ----- | -------- | ----- | --------------- |
| `1`   | jp       | `5`   | estrella        |
| `2`   | pelota   | `6`   | bala (rápida)   |
| `3`   | caja     | `7`   | globo (flota)   |
| `4`   | triángulo |       |                 |

**Acciones (un toque)**

| Tecla          | Acción                                 |
| -------------- | -------------------------------------- |
| Click          | Spawn                                  |
| Shift + Click  | Bomba en el cursor                     |
| `Space`        | Bomba en el cursor                     |
| `Enter`        | SUPER bomba central                    |
| `E`            | Lluvia de confetti                     |
| `R`            | Limpiar todas las entidades            |

**Mantener pulsada**

| Tecla | Efecto continuo                                |
| ----- | ---------------------------------------------- |
| `B`   | Agujero negro en el cursor                     |
| `V`   | Empuje radial desde el cursor                  |
| `N`   | Viento a la izquierda                          |
| `M`   | Viento a la derecha                            |
| `Q`   | Lluvia continua del tipo seleccionado          |
| `Z`   | Slow motion (×0.25)                            |
| `X`   | Fast forward (×2)                              |

**Mundo**

| Tecla | Efecto                                         |
| ----- | ---------------------------------------------- |
| `G`   | Ciclar gravedad: normal → lunar → 0 → invertida |
| `C`   | Activar / desactivar colisiones entre entidades |
| `F`   | Ciclar fricción: normal → hielo → pegajosa     |
| `P`   | Pausa / play                                   |

**Interfaz**

| Tecla | Efecto                                         |
| ----- | ---------------------------------------------- |
| `T`   | Modo fiesta (colores que cambian)              |
| `D`   | Wireframe debug                                |
| `S`   | Sonido on / off                                |
| `H`   | Ocultar / mostrar HUD                          |
| `?`   | Panel de ayuda con todas las teclas            |

Los sonidos de impacto, spawn, bomba y confetti están sintetizados en vivo con la Web Audio API — no hay assets de audio que cargar.

## Desarrollo local

```bash
npm install
cp .env.example .env      # y rellena con tus claves de Supabase
npm run dev
```

Abre http://localhost:5173.

> Si no configuras Supabase, la app funciona igual pero el chat aparece deshabilitado.

## Configurar Supabase (chat)

1. Crea un proyecto gratis en [supabase.com](https://supabase.com).
2. En el SQL Editor, pega y ejecuta el contenido de [`supabase/schema.sql`](./supabase/schema.sql).
3. Ve a **Project Settings → API** y copia:
   - `Project URL` → `VITE_SUPABASE_URL`
   - `anon public key` → `VITE_SUPABASE_ANON_KEY`
4. Pega ambos en `.env` (local) y en las variables de entorno de tu hosting.

El esquema crea la tabla `messages` con RLS, políticas anónimas de insert/select, y un trigger que auto-poda a 500 mensajes.

## Deploy gratis

### Opción recomendada: Cloudflare Pages

1. Sube el repo a GitHub.
2. En Cloudflare Pages → *Create project* → conecta el repo.
3. Build command: `npm run build`. Output directory: `dist`.
4. Variables de entorno: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
5. Deploy. Cada push a main redeploya automáticamente.

### Alternativa: Vercel

`vercel --prod` con las mismas variables; framework auto-detectado como Vite.

### Alternativa: Netlify

Build command `npm run build`, publish dir `dist`, mismas variables.

## Notas de seguridad

- El `anon key` de Supabase es público por diseño; la seguridad vive en las políticas RLS.
- Para producción real conviene añadir rate-limiting (Edge Function o moderación) y filtro de contenido.
- `jp.png` se sirve desde `public/` — reemplázalo cuando quieras y el spawner lo recoge.

## Estructura

```
src/
  components/   PhysicsCanvas, HUD, Chat, NicknameModal
  hooks/        useChat
  lib/          physics.ts, supabase.ts
supabase/       schema.sql
public/         jp.png
```
