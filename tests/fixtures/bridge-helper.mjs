import { createInterface } from "node:readline";
const requests = new Map();
let credits = 0;
let cancellations = 0;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  const { id, op, requestId } = message;
  if (op === "status") send({ id, type: "result", value: { credits, cancellations } });
  if (op === "forward") {
    requests.set(id, { count: 0, delay: message.url.includes("slow=1") ? 700 : 0 });
    send({ id, type: "head", status: 200, headers: { "content-type": "text/plain" } });
  }
  if (op === "credit") {
    credits++;
    const request = requests.get(requestId);
    if (!request) return;
    setTimeout(() => {
      if (!requests.has(requestId)) return;
      if (request.count === 0) {
        request.count = 1;
        send({ id: requestId, type: "chunk", data: Buffer.from("hello").toString("base64") });
      } else {
        requests.delete(requestId);
        send({ id: requestId, type: "end" });
      }
    }, request.delay);
  }
  if (op === "cancel") { cancellations++; requests.delete(requestId); }
  if (op === "azure.login") {
    send({ id, type: "login", verificationUri: "https://microsoft.com/devicelogin", userCode: "ABC12345" });
    send({ id, type: "result", value: { authenticated: true } });
  }
  if (op === "error") send({ id, type: "error", error: "Operation rejected" });
  if (op === "malformed") process.stdout.write("not json\n");
});
