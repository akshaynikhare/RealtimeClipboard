/**
 * core/i18n.js — the rules that make partial coverage safe.
 *
 * Every assertion here is a behaviour something else depends on: the app ships
 * a module before its translation, so a missing key must render English rather
 * than a blank or a key name; and a catalogue that fails to load must leave a
 * working English app rather than take the session down with it.
 */

import { t, pick, load, lang, useCatalogue, SUPPORTED } from "../../src/core/i18n.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
};

console.log("\nI18N\n");

/* ---- the English fallback, which is the whole design ---- */

useCatalogue("en", null);
ok("with no catalogue, a string renders itself", t("Not connected") === "Not connected");

useCatalogue("zh", { "Connected": "已连接" });
ok("a translated string renders its translation", t("Connected") === "已连接");
ok("an untranslated string renders English",
   t("Not connected") === "Not connected",
   "a module must be able to ship before its translation does");
ok("an empty translation falls back rather than blanking the label",
   (useCatalogue("zh", { "Offline": "" }), t("Offline") === "Offline"));

/* ---- placeholders ---- */

useCatalogue("ru", { "Pointer visible to {n} devices": "Ваш курсор виден устройствам: {n}" });
ok("a placeholder is substituted",
   t("Pointer visible to {n} devices", { n: 3 }) === "Ваш курсор виден устройствам: 3");
ok("word order may move around the placeholder",
   t("Pointer visible to {n} devices", { n: 3 }).endsWith("3"),
   "Russian puts the count last; English does not");
useCatalogue("en", null);
ok("an unknown placeholder is left alone rather than printing undefined",
   t("{path} connected", {}) === "{path} connected");
ok("a placeholder survives the English fallback",
   t("{path} connected", { path: "P2P" }) === "P2P connected");

/* ---- picking a language ---- */

ok("an explicit choice wins over the browser", pick("ru", ["zh-CN"]) === "ru");
ok("an explicit English wins over a browser asking for Chinese",
   pick("en", ["zh-CN", "zh"]) === "en",
   "choosing English is a choice, not the absence of one");
ok("no choice follows the browser", pick("", ["pt-BR", "en"]) === "pt");
ok("a region tag matches its base language", pick("", ["zh-Hans-CN"]) === "zh");
ok("an unsupported browser language falls back to English", pick("", ["ja", "ko"]) === "en");
ok("no choice and no preference is English", pick("", []) === "en");
ok("a stored language that no longer exists is ignored", pick("xx", ["ru"]) === "ru");

/* ---- loading ---- */

const before = lang();
ok("loading an unknown language changes nothing",
   (await load("xx")) === before || (await load("xx")) === "en");

for (const code of SUPPORTED) {
  const got = await load(code);
  ok(`${code}: catalogue loads and takes effect`, got === code && lang() === code);
}

console.log(`\n${"=".repeat(58)}\nI18N: ${pass}/${pass + fail} passed\n${"=".repeat(58)}`);
if (fail) process.exit(1);
