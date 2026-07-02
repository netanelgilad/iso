// A completely standard Node Q&A program — process.stdin/process.stdout only, zero
// platform-specific code, ordinary top-level script shape. (process.exit at the end is the
// standard Node idiom for stdin-holding CLIs — an open stdin keeps any node process alive.)
const ask = (q) => new Promise((resolve) => {
  process.stdout.write(q);
  process.stdin.once("data", (c) => resolve(c.toString().trim()));
});
(async () => {
  const name = await ask("What is your name? ");
  console.log("Hello, " + name + "!");
  const color = await ask("What is your favorite color? ");
  console.log(name + "'s favorite color is " + color + ".");
  process.exit(0);
})();
