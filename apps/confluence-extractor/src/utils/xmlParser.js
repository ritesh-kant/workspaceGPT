import { parseDocument } from "htmlparser2";

export function extractTextFromXML(xmlContent) {
    const document = parseDocument(xmlContent);
    let extractedText = "";

    function traverse(node) {
        if (node.type === "text") {
            extractedText += node.data.trim() + " ";
        } else if (node.children) {
            node.children.forEach(traverse);
        }
    }

    traverse(document);
    return extractedText.replace(/\s+/g, " ").trim();
}