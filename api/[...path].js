// Vercel catch-all: routes every /api/* request into the shared Express app.
// The Express app instance is itself a (req, res) handler.
import app from "../server/app.js";

export default app;
