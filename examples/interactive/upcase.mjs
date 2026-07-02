// Standard read-until-EOF consumer (wc/upcase-style): process.stdin 'data' + 'end' events.
let text = "";
process.stdin.on("data", (c) => (text += c.toString()));
process.stdin.on("end", () => {
  const lines = text.split("\n").filter(Boolean);
  for (const l of lines) console.log(l.toUpperCase());
  console.log("(" + lines.length + " lines)");
});
