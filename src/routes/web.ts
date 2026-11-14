import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shortCode } from "../mcp/hosted.js";
import type { Inbox } from "../inbox/inbox.js";

export function webRoutes(d: { inbox: Inbox }): express.Router {
  const router = express.Router();
  const webDir = fileURLToPath(new URL("../web", import.meta.url));
  // The app itself: static files under a strict CSP, since it renders text from strangers' emails.
  router.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    next();
  });
  // On-device Whisper for "say a payment": the worker may fetch the model from Hugging Face and run WASM, nothing else.
  const nodeModules = fileURLToPath(new URL("../../node_modules/", import.meta.url));
  router.get("/whisper-worker.js", (_req, res) => {
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co");
    res.sendFile("whisper-worker.js", { root: webDir });
  });
  // The image copies just these browser files into vendor/ (see Dockerfile); dev and tests serve them from node_modules.
  const vendor = fileURLToPath(new URL("../../vendor/", import.meta.url));
  const from = (built: string, dev: string) => existsSync(vendor + built) ? vendor + built : nodeModules + dev;
  router.use("/vendor/transformers", express.static(from("transformers", "@huggingface/transformers/dist"), { immutable: true, maxAge: "30d" }));
  router.use("/vendor/ort", express.static(from("ort", "onnxruntime-web/dist"), { immutable: true, maxAge: "30d" }));
  // Lenis: the landing page's damped smooth scroll.
  router.use("/vendor/lenis", express.static(nodeModules + "lenis/dist", { immutable: true, maxAge: "30d" }));
  router.use("/film", express.static(webDir + "/film", { maxAge: "7d" }));
  router.use("/", (req, res, next) => {
    if (req.method === "GET" && /^\/(index\.html|app\.js|app\.css|claim|c\/[\w-]+|connect\/[\w-]+|approve\/.+)?$/.test(req.path)) {
      res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader("cache-control", "no-cache");
    }
    next();
  }, express.static(webDir, { index: "index.html" }));
  // A one-tap approval link opens the app on that invoice (the page asks for sign-in if needed).
  router.get("/approve/:id", (_req, res) => res.sendFile("index.html", { root: webDir }));
  // A chat app's "Sign in with Sayso" lands here: the app shows Allow or Not now.
  router.get("/connect/:id", (_req, res) => res.sendFile("index.html", { root: webDir }));
  router.get("/app", (_req, res) => res.sendFile("index.html", { root: webDir }));
  // The short form agents send: /p/ and a hash of the invoice id.
  router.get("/p/:code", (req, res) => {
    const item = d.inbox.byShortCode(req.params.code, shortCode);
    res.redirect(302, item ? `/approve/${encodeURIComponent(item.id)}` : "/");
  });
  // An agent's auth.md claim link lands here (/c/ is the short form); the app asks for the code and a passkey check.
  router.get(["/claim", "/c/:token"], (_req, res) => res.sendFile("index.html", { root: webDir }));
  return router;
}
