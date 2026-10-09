import PDFDocument from "pdfkit";
// Exercise native font metrics and an actual landscape PDF without database or provider access.
const document = new PDFDocument({
  size: [1224, 792],
  margin: 14.17,
  compress: false,
});
const chunks = [];
const completed = new Promise((resolve, reject) => {
  document.on("data", (chunk) => chunks.push(chunk));
  document.on("error", reject);
  document.on("end", resolve);
});
document.font("Helvetica-Bold").fontSize(16).text("Schedule");
document.font("Helvetica").fontSize(10).text("Native landscape report");
document.end();
await completed;
const bytes = Buffer.concat(chunks);
if (
  !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
  !bytes.includes(Buffer.from("/MediaBox [0 0 1224 792]"))
)
  throw new Error("Native landscape PDF rendering failed.");
console.log("Native PDF fonts and landscape rendering verified.");
