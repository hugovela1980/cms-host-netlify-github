import { zipSync } from "fflate";

function syntheticDocx() {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Privacy Policy</w:t></w:r></w:p>
<w:p><w:r><w:t>Initial wording.</w:t></w:r></w:p>
</w:body></w:document>`;
    return Buffer.from(zipSync({ "word/document.xml": new TextEncoder().encode(xml) }));
}

function syntheticPdf() {
    const stream = "BT /F1 12 Tf 50 700 Td (Privacy Policy Initial wording.) Tj ET";
    const objects = [
        "<</Type/Catalog/Pages 2 0 R>>",
        "<</Type/Pages/Kids[3 0 R]/Count 1>>",
        "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
        "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
        `<</Length ${Buffer.byteLength(stream)}>>\nstream\n${stream}\nendstream`,
    ];
    let output = "%PDF-1.4\n";
    const offsets = [];
    for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(output));
        output += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(output);
    output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    output += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
    return Buffer.from(output +
        `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`);
}

export function syntheticLegalConfig() {
    const pdfPaths = ["public/downloads/legal/Example_Privacy.pdf"];
    const files = new Map([
        ["docs/example/privacy.docx", syntheticDocx()],
        ["docs/example/privacy.pdf", syntheticPdf()],
    ]);
    return { pdfPaths, allowManifestlessOriginals: true,
        pages: { privacy: { label: "Privacy Policy",
            originalDocumentPath: "docs/example/privacy.docx",
            originalPdfPath: "docs/example/privacy.pdf", pdfPath: pdfPaths[0],
            sourceTitles: ["Privacy Policy"], ignoredPdfFooterTexts: [] } },
        manifestPath: "content/legal.json",
        renderedPath: "src/_data/legalDocuments.json",
        sourceDirectory: "content/legal-documents",
        readOriginal: async (path) => files.get(path) ?? null };
}
