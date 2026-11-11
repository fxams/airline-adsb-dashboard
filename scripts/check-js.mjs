#!/usr/bin/env node
// Pre-deploy / CI: node --check every public bundle (and the Node entrypoints).
// Catches parse errors like the PR #23 posNote ternary that left initMap undefined.
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
function check(rel) {
  const fp = path.join(root, rel);
  if (!fs.existsSync(fp)) { fail.push("missing " + rel); return; }
  const r = spawnSync(process.execPath, ["--check", fp], { encoding: "utf8" });
  if (r.status !== 0) fail.push(rel + ": " + (r.stderr || r.stdout || "node --check failed").trim());
}

const pub = fs.readdirSync(path.join(root, "public")).filter((f) => f.endsWith(".js")).sort();
if (!pub.length) fail.push("no public/*.js");
for (const f of pub) check("public/" + f);
for (const f of ["server.js", "live-feed.js", "wx.js"]) check(f);

const mapSrc = fs.readFileSync(path.join(root, "public/map.js"), "utf8");
try { new Function(mapSrc); } catch (e) { fail.push("map.js new Function: " + e.message); }
if (/\(coast\?"Snapshot[\s\S]{0,500}Times UTC\."\)\s*:/.test(mapSrc)) {
  fail.push("map.js posNote: stray ) after coast branch (PR #23 / #25)");
}
if (!/function initMap\(/.test(mapSrc) || !/addSource\("live"/.test(mapSrc)) {
  fail.push("map.js missing initMap / live source");
}

if (fail.length) {
  console.error("check-js FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("check-js OK", pub.length, "public/*.js");
