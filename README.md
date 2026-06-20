# Eternaura v3 — IA Educativa

Plataforma educativa con IA real, panel docente con contraseña, instrucciones personalizadas, biblioteca docente permanente y memoria del alumno. Un solo archivo HTML, sin instalación, deployable a Netlify o Cloudflare Pages en minutos.

---

## Estructura del proyecto

```
eternaura_v3/
├── index.html                  ← Frontend completo (todo en un archivo)
├── netlify.toml                ← Configuración para Netlify
├── netlify/functions/
│   └── chat.js                 ← Función serverless para Netlify
└── functions/api/
    └── chat.js                 ← Función serverless para Cloudflare Pages
```

---

## Opción A — Subir a Netlify

1. Entrá a https://app.netlify.com y creá una cuenta (gratis).
2. En el dashboard → **"Add new project"** → **"Deploy manually"**.
3. Arrastrá la carpeta `eternaura_v3` completa al área de drop.
4. Una vez creado el sitio, andá a:
   **Project configuration → Environment variables → Add a variable**
   - Nombre: `OPENROUTER_API_KEY`
   - Valor: tu clave de OpenRouter (`sk-or-v1-...`)
5. Volvé a **Deploys** → **"Trigger deploy"** para que tome la variable.
6. Listo. Tu sitio está en `https://algo-random.netlify.app`.

---

## Opción B — Subir a Cloudflare Pages

1. Entrá a https://dash.cloudflare.com y creá una cuenta (gratis).
2. **Workers & Pages → Create → Pages → Upload assets**.
3. Arrastrá la carpeta `eternaura_v3` completa.
4. Una vez deployado → **Settings → Environment variables → Add variable (Production)**
   - Nombre: `OPENROUTER_API_KEY`
   - Valor: tu clave de OpenRouter
5. Republicá para que tome la variable.
6. Listo. Tu sitio está en `https://algo-random.pages.dev`.

---

## Obtener la API key de OpenRouter (gratis)

1. Registrate en https://openrouter.ai
2. Andá a **API Keys → Create key**
3. Copiá la clave (empieza con `sk-or-v1-...`)
4. Los modelos marcados con `:free` son completamente gratuitos

---

## Panel Docente

Accedé desde el botón **⚙️ Docente** en la esquina superior derecha.

**Contraseña por defecto: `docente2024`**
Cambiala desde el mismo panel antes de compartir el sitio.

### Qué podés configurar:
- **Nombre de la IA** — personalizar el nombre del asistente
- **Materia / área** — el tema central de la plataforma
- **Instrucciones personalizadas** — system prompt propio: cómo debe comportarse la IA, qué puede y qué no responder, el nivel educativo, el enfoque pedagógico, restricciones, etc.
- **Modo pedagógico por defecto** — qué modo ven los alumnos al entrar
- **Modelo de IA** — elegir entre 6 modelos gratuitos de OpenRouter
- **Biblioteca docente** — subir PDFs, TXT y MD como base de conocimiento permanente (sobreviven entre sesiones)
- **Exportar / importar configuración** — backup completo en JSON para compartir entre dispositivos

---

## Funcionalidades del alumno

- **4 modos pedagógicos**: Socrático · Directo · Ejercicios · Evaluador
- **Apuntes de sesión**: PDF (hasta 60 páginas) y TXT/MD — procesados en el navegador, sin subir a ningún servidor
- **RAG mejorado**: recuperación por relevancia (scoring ponderado por frecuencia y longitud de keyword), diferenciando fuentes docentes y propias del alumno
- **Historial de conversación**: las últimas 14 interacciones se incluyen en cada llamada al modelo (capped para evitar errores de contexto)
- **Memoria del alumno**: sesiones, mensajes totales, temas trabajados — persiste entre sesiones (localStorage)

---

## Modelos gratuitos disponibles

| Modelo | Fortalezas |
|--------|-----------|
| Llama 3.3 70B | Recomendado — equilibrado, buena instrucción |
| Llama 4 Maverick | Muy capaz, buen razonamiento |
| Gemini Flash 1.5 | Rápido, bueno para respuestas concisas |
| DeepSeek Chat | Excelente en matemáticas y ciencias |
| Mistral 7B | Liviano, respuestas rápidas |
| Qwen 2.5 72B | Muy bueno en contenido académico |

Ver todos los modelos gratuitos: https://openrouter.ai/models?q=free

---

## Privacidad

- Los documentos **nunca salen del navegador** completos — solo se envían fragmentos relevantes al modelo con cada consulta.
- La API key vive únicamente en las variables de entorno del servidor (Netlify/Cloudflare) y nunca es visible en el código del frontend.
- La contraseña del panel docente se guarda en localStorage — no viaja a ningún servidor.

