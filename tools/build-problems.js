// Builds site/problems.html: every Troubleshoot answer as plain HTML that reads
// without JavaScript, for search engines and for people who block scripts.
// Run with: node tools/build-problems.js   (tests/check_site_data.js checks it is current)
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const OUT = path.join(root, "site/problems.html");

function load() {
  global.window = {};
  for (const f of ["data.js", "yaml.js", "engine.js", "scenarios.js"]) {
    const file = path.join(root, "site", f);
    delete require.cache[file];
    require(file);
  }
  return { Q: window.QUEST, titles: Object.fromEntries(window.AQScenarios.SCENARIOS.map((s) => [s.id, s.title])) };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// `code` in the data becomes <code>.
const text = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

function build() {
  const { Q, titles } = load();
  const byId = Object.fromEntries(Q.doctor.map((d) => [d.id, d]));
  const toc = Q.doctorGroups.map(([group, ids]) => `      <h2>${esc(group)}</h2>\n      <ul>\n${ids.map((id) => `        <li><a href="#${id}">${esc(byId[id].title)}</a></li>`).join("\n")}\n      </ul>`).join("\n");
  const sections = Q.doctor.map((d) => {
    const lv = Q.levels.find((l) => l.id === d.level);
    const practise = d.scenarios.filter((id) => titles[id]).map((id) => `<a href="index.html#play/${id}">${esc(titles[id])}</a>`).join(", ");
    return `    <section class="card answer" id="${d.id}">
      <h2>${esc(d.title)}</h2>
      <h3>Error</h3>
      <pre class="err"><code>${esc(d.error)}</code></pre>
      <h3>Symptom</h3>
      <p>${text(d.symptom)}</p>
      <h3>Why it happens</h3>
      <p>${text(d.cause)}</p>
      <h3>Confirm</h3>
      <pre><code>${esc(d.confirm.join("\n"))}</code></pre>
      <h3>Fix</h3>
      <p>${text(d.fix)}</p>
      <h3>Prevent</h3>
      <p>${text(d.prevent)}</p>
      <p class="note"><strong>Now learn it:</strong> ${practise ? `break and fix it yourself in ${practise}, then take` : "take"} <a href="index.html#path">Level ${lv.id} · ${esc(lv.title)}</a>. <a href="index.html#fix/${d.id}">Open in the app</a>.</p>
    </section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="description" content="GitHub Actions errors and how to fix them: ${Q.doctor.length} error messages, each with the cause, how to confirm it, the fix and how to prevent it.">
  <meta property="og:title" content="GitHub Actions errors and fixes · Actions Quest">
  <meta property="og:description" content="Every common GitHub Actions error message, with cause, confirmation, fix and prevention.">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${Q.site}problems.html">
  <link rel="canonical" href="${Q.site}problems.html">
  <title>GitHub Actions errors and fixes</title>
  <link rel="stylesheet" href="style.css">
  <link rel="icon" href="logo.svg" type="image/svg+xml">
</head>
<body class="problems">
  <header class="top">
    <div class="wrap top-inner">
      <a class="brand" href="index.html"><img src="logo.svg" alt="" width="22" height="22">Actions Quest</a>
      <nav aria-label="Sections"><a href="index.html#doctor">Search errors</a><a href="index.html#playground">Playground</a></nav>
    </div>
  </header>
  <main class="wrap">
    <h1 class="problems-title">GitHub Actions errors and fixes</h1>
    <p class="lede">${Q.doctor.length} error messages from real runs. Each has the exact text, why it happens, how to confirm it, the fix and how to prevent it. Then learn it for good: break and fix each one yourself in the <a href="index.html#playground">playground</a>.</p>
    <nav class="toc card" aria-label="Problems">
${toc}
    </nav>
${sections}
  </main>
  <footer class="foot">
    <div class="wrap foot-base">
      <p>© 2024–2026 Sandeep Komal Pothu and contributors. Open source under the MIT License.</p>
      <p class="foot-tm">GitHub® and GitHub Actions are trademarks of GitHub, Inc. This project is independent and not affiliated with GitHub.</p>
    </div>
  </footer>
</body>
</html>
`;
}

if (require.main === module) {
  fs.writeFileSync(OUT, build());
  console.log(`wrote ${path.relative(root, OUT)}`);
}
module.exports = { build, OUT };
