// Vercel serverless entry: every /api/* request is rewritten to this single
// function (see vercel.json), which hands off to the shared Express app. The
// Express app instance is itself a (req, res) handler and routes on the original
// URL, so nested paths like /api/amilia/members/summary resolve correctly.
import app from "../server/app.js";

export default app;
