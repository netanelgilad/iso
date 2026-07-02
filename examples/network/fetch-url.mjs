// fetch a URL from inside a machine — the networks proofs' client script (plain node script)
(async () => {
  const url = process.argv[2];
  let code = 2;
  try {
    const r = await fetch(url);
    const text = await r.text();
    console.log("status:", r.status);
    console.log(text.length > 400 ? text.slice(0, 400) + "…(" + text.length + " bytes)" : text);
    code = r.ok ? 0 : 1;
  } catch (e) {
    console.error("fetch failed:", (e && e.message) || String(e));
  }
  process.exit(code);
})();
