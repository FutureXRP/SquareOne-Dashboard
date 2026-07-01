# public/ — static assets served at the site root

Drop the building's logo here to brand the dashboard:

- **`public/brand-logo.svg`** (preferred) or **`public/brand-logo.png`**

It's picked up automatically by the masthead and login screen (see
`src/BrandLogo.jsx`). If no file is present, a placeholder square is shown.

A wide "wordmark" logo works too — it's height-constrained and keeps its aspect
ratio. Prefer SVG (crisp at any size) or a transparent PNG at ~2× display size.
