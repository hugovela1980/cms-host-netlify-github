import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
// PDF.js uses this handler directly in Node. Import it so a bundled Function
// does not have to find pdf.worker.mjs beside its generated entry point.
import "pdfjs-dist/legacy/build/pdf.worker.mjs";

import { CmsApiError } from "../http.js";

export const LEGAL_MAX_BYTES = 8 * 1024 * 1024;

export function legalHash(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function decodeXml(value) {
    return value.replace(/&#(x[0-9a-f]+|\d+);|&(?:amp|lt|gt|quot|apos);/gi, (entity, number) => {
        if (number) {
            const code = number[0].toLowerCase() === "x" ? parseInt(number.slice(1), 16) : Number(number);
            return Number.isInteger(code) && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
                ? String.fromCodePoint(code) : "\ufffd";
        }
        return { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" }[entity.toLowerCase()];
    });
}

function appendBlock(blocks, type, value) {
    const text = value.trim();
    if (!text) return;
    if (type === "list") {
        if (blocks.at(-1)?.type !== "list") blocks.push({ type: "list", items: [] });
        blocks.at(-1).items.push(text);
    } else {
        blocks.push({ type, text });
    }
}

function visibleMarkdownText(value) {
    if (/!\[[^\]]*\]\([^)]*\)|<\/?[a-z][^>]*>/i.test(value)) {
        throw new CmsApiError("UNSUPPORTED_LEGAL_MARKDOWN", "Remove embedded images or HTML from the Markdown document.", 422);
    }
    return value
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(?<!\\)(\*\*|__|\*|_|`)(.*?)\1/g, "$2")
        .replace(/\\([\\`*_{}\[\]()#+.!>-])/g, "$1");
}

export function parseLegalText(text, extension) {
    if (typeof text !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
        throw new CmsApiError("INVALID_LEGAL_DOCUMENT", "The document contains unsupported control characters.", 422);
    }
    const blocks = [];
    const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    let paragraph = [];
    const flush = () => {
        if (paragraph.length) appendBlock(blocks, "paragraph", paragraph.join(" "));
        paragraph = [];
    };
    for (const line of lines) {
        if (!line.trim()) { flush(); continue; }
        const heading = extension === "md" ? /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line) : null;
        const list = /^\s*[-*+]\s+(.+)$/.exec(line);
        const numbered = /^\s*\d+[.)]\s+/.test(line);
        if (heading || list) {
            flush();
            appendBlock(blocks, heading ? "heading" : "list",
                extension === "md" ? visibleMarkdownText((heading ?? list)[1]) : (heading ?? list)[1]);
        } else {
            if (numbered) flush();
            paragraph.push(extension === "md" ? visibleMarkdownText(line.trim()) : line.trim());
            if (numbered) flush();
        }
    }
    flush();
    if (!blocks.length) throw new CmsApiError("EMPTY_LEGAL_DOCUMENT", "The document has no readable text.", 422);
    return { sourceTitle: "", blocks };
}

export function parseLegalDocx(bytes, { sourceTitles = [] } = {}) {
    let xml;
    let numberingXml = "";
    try {
        const files = unzipSync(bytes, { filter: (entry) =>
            ["word/document.xml", "word/numbering.xml"].includes(entry.name) && entry.originalSize <= 2_000_000 });
        xml = new TextDecoder("utf-8", { fatal: true }).decode(files["word/document.xml"]);
        if (files["word/numbering.xml"]) numberingXml = new TextDecoder("utf-8", { fatal: true }).decode(files["word/numbering.xml"]);
    } catch {
        throw new CmsApiError("INVALID_LEGAL_DOCUMENT", "The Word document could not be read.", 422);
    }
    if (!xml || !/<w:document(?:\s|>)/.test(xml)) {
        throw new CmsApiError("INVALID_LEGAL_DOCUMENT", "The Word document has no readable body.", 422);
    }
    const blocks = [];
    const abstractLevels = new Map();
    for (const abstract of numberingXml.matchAll(/<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
        for (const level of abstract[2].matchAll(/<w:lvl\b[^>]*\bw:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
            abstractLevels.set(`${abstract[1]}:${level[1]}`, {
                format: /<w:numFmt\b[^>]*\bw:val="([^"]+)"/.exec(level[2])?.[1],
                start: Number(/<w:start\b[^>]*\bw:val="(\d+)"/.exec(level[2])?.[1] ?? 1),
                marker: decodeXml(/<w:lvlText\b[^>]*\bw:val="([^"]+)"/.exec(level[2])?.[1] ?? "%1."),
            });
        }
    }
    const numbering = new Map([...numberingXml.matchAll(/<w:num\b[^>]*\bw:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)]
        .map((match) => [match[1], /<w:abstractNumId\b[^>]*\bw:val="(\d+)"/.exec(match[2])?.[1]]));
    const counters = new Map();
    for (const match of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
        const paragraph = match[1];
        const style = /<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(paragraph)?.[1] ?? "";
        const numId = /<w:numId\b[^>]*\bw:val="(\d+)"/.exec(paragraph)?.[1];
        const level = /<w:ilvl\b[^>]*\bw:val="(\d+)"/.exec(paragraph)?.[1] ?? "0";
        const definition = numId && numId !== "0" ? abstractLevels.get(`${numbering.get(numId)}:${level}`) : null;
        if ((numId && numId !== "0" && !definition) || (/^ListNumber/i.test(style) && !definition)) {
            throw new CmsApiError("UNSUPPORTED_LEGAL_NUMBERING", "This Word document uses numbering that cannot be preserved.", 422);
        }
        const list = definition?.format === "bullet" || /^ListBullet/i.test(style);
        const heading = /^Heading[1-6]$/i.test(style);
        const parts = [];
        for (const node of paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:tab|br|cr)\b[^>]*\/?\s*>/g)) {
            parts.push(node[1] === undefined ? " " : decodeXml(node[1]));
        }
        let value = parts.join("");
        if (definition && !list) {
            if (definition.format !== "decimal") {
                throw new CmsApiError("UNSUPPORTED_LEGAL_NUMBERING", "This Word document uses numbering that cannot be preserved.", 422);
            }
            const key = `${numId}:${level}`;
            const number = counters.get(key) ?? definition.start;
            counters.set(key, number + 1);
            const marker = definition.marker.replace(/%(\d+)/g, (_, index) => {
                const referencedLevel = String(Number(index) - 1);
                return String(referencedLevel === level ? number : counters.get(`${numId}:${referencedLevel}`) - 1 || "?");
            });
            if (marker.includes("?")) throw new CmsApiError("UNSUPPORTED_LEGAL_NUMBERING", "This Word document uses numbering that cannot be preserved.", 422);
            value = `${marker} ${value}`;
        }
        appendBlock(blocks, list ? "list" : heading ? "heading" : "paragraph", value);
    }
    if (!blocks.length) throw new CmsApiError("EMPTY_LEGAL_DOCUMENT", "The Word document has no readable text.", 422);
    const first = blocks[0];
    const sourceTitle = first.type !== "list" && sourceTitles.some((title) =>
        title.toLocaleLowerCase() === first.text.toLocaleLowerCase())
        ? blocks.shift().text : "";
    return { sourceTitle, blocks };
}

export function validateLegalBlocks(document) {
    if (!document || typeof document !== "object" || Array.isArray(document) ||
        typeof document.sourceTitle !== "string" || !Array.isArray(document.blocks) ||
        document.blocks.length === 0 || document.blocks.length > 1000) return false;
    return document.blocks.every((block) => block && typeof block === "object" &&
        ((["heading", "paragraph"].includes(block.type) && typeof block.text === "string" && block.text.trim() && block.text.length <= 20000) ||
        (block.type === "list" && Array.isArray(block.items) && block.items.length > 0 && block.items.length <= 500 &&
            block.items.every((item) => typeof item === "string" && item.trim() && item.length <= 20000))));
}

export function legalDocumentText(document) {
    return [document.sourceTitle, ...document.blocks.flatMap((block) => block.type === "list" ? block.items : [block.text])]
        .filter(Boolean).join(" ");
}

export function normalizeLegalText(value) {
    return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function compareLegalText(document, pdfText) {
    if (typeof pdfText !== "string" || !pdfText.trim()) {
        return { status: "could-not-verify", explanation: "No reliable text could be extracted from the PDF." };
    }
    const webpage = normalizeLegalText(legalDocumentText(document));
    const downloadable = normalizeLegalText(pdfText);
    if (webpage === downloadable) return { status: "matches", explanation: "The document and PDF text match." };
    const left = webpage.split(" ");
    const right = downloadable.split(" ");
    const index = left.findIndex((word, i) => word !== right[i]);
    const at = index < 0 ? Math.min(left.length, right.length) : index;
    const context = (words) => words.slice(Math.max(0, at - 5), at + 8).join(" ");
    return { status: "different", explanation: `Text differs near word ${at + 1}. Webpage: “${context(left)}”. PDF: “${context(right)}”.` };
}

export async function extractPdfText(bytes, { ignoredFooterTexts = [] } = {}) {
    if (new TextDecoder("latin1").decode(bytes.slice(0, 5)) !== "%PDF-") {
        throw new CmsApiError("INVALID_LEGAL_PDF", "The file is not a PDF.", 415);
    }
    let pdf;
    try {
        const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, stopAtErrors: true, verbosity: 0 });
        pdf = await task.promise;
    } catch {
        throw new CmsApiError("INVALID_LEGAL_PDF", "The PDF could not be opened.", 415);
    }
    if (pdf.numPages > 100) {
        await pdf.cleanup?.();
        throw new CmsApiError("INVALID_LEGAL_PDF", "The PDF has too many pages.", 413);
    }
    try {
        const pageItems = [];
        for (let number = 1; number <= pdf.numPages; number += 1) {
            const page = await pdf.getPage(number);
            const content = await page.getTextContent();
            pageItems.push(content.items);
        }
        return pdfTextFromPageItems(pageItems, { ignoredFooterTexts });
    } catch {
        return null;
    } finally {
        await pdf?.cleanup?.();
    }
}

export function pdfTextFromPageItems(pageItems, { ignoredFooterTexts = [] } = {}) {
    const approvedRunningFooters = new Set(ignoredFooterTexts);
    return pageItems.map((items) => items.filter((item) =>
        item.str?.trim() !== "•" &&
        !(item.transform?.[5] < 50 && approvedRunningFooters.has(item.str?.trim())))
        .map((item) => `${item.str ?? ""}${item.hasEOL ? "\n" : " "}`).join("")).join("\n");
}
