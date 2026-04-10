import { parseDocument } from "htmlparser2";
import { DomUtils } from "htmlparser2";

function extractTextFromXML(xmlContent: any) {
    const document = parseDocument(xmlContent, { xmlMode: true });
    let markdown = "";

    function traverse(node:any) {
        if (node.type === "text" || node.type === "cdata") {
            let text = node.data.trim();
            text = cleanText(text);
            if (text) markdown += text + " ";
        } else if (node.type === "tag") {
            if (node.name === "ac:structured-macro") {
                const titleNode = DomUtils.findOne(
                    (n) => n.name === "ac:parameter" && n.attribs["ac:name"] === "title",
                    node.children
                );
                if (titleNode) {
                    markdown += cleanText(DomUtils.textContent(titleNode).trim()) + " ";
                }
                
                const plainTextBody = DomUtils.findOne(
                    (n) => n.name === "ac:plain-text-body",
                    node.children
                );
                if (plainTextBody) {
                    markdown += "\n```\n" + DomUtils.textContent(plainTextBody).trim() + "\n```\n";
                }

                const richTextBody = DomUtils.findOne(
                    (n) => n.name === "ac:rich-text-body",
                    node.children
                );
                if (richTextBody) {
                    DomUtils.getChildren(richTextBody).forEach(traverse);
                }
            } else {
                switch (node.name) {
                    case "h1":
                        markdown += `\n# ${cleanText(DomUtils.textContent(node).trim())}\n\n`;
                        break;
                    case "h2":
                        markdown += `\n## ${cleanText(DomUtils.textContent(node).trim())}\n\n`;
                        break;
                    case "h3":
                        markdown += `\n### ${cleanText(DomUtils.textContent(node).trim())}\n\n`;
                        break;
                    case "p":
                        markdown += `\n${cleanText(DomUtils.textContent(node).trim())}\n\n`;
                        break;
                    case "a":
                        const href = node.attribs.href;
                        const text = cleanText(DomUtils.textContent(node).trim());
                        markdown += `[${text}](${href})\n\n`;
                        break;
                    case "table":
                        const rows = DomUtils.findAll(n => n.name === "tr", node.children);
                        rows.forEach((row, index) => {
                            const cols = DomUtils.findAll(n => n.name === "td" || n.name === "th", row.children);
                            markdown += "| " + cols.map(col => extractCellText(col)).join(" | ") + " |\n";
                            if (index === 0) {
                                markdown += "| " + cols.map(() => "---").join(" | ") + " |\n";
                            }
                        });
                        markdown += "\n";
                        break;
                    default:
                        DomUtils.getChildren(node).forEach(traverse);
                        break;
                }
            }
        }
    }

    function extractCellText(node:any) {
        let cellText = "";
        function recurse(n: any) {
            if (n.type === "tag" && n.name === "ac:structured-macro") {
                const plainTextBody = DomUtils.findOne(
                    (el) => el.name === "ac:plain-text-body",
                    n.children
                );
                if (plainTextBody) {
                    cellText += "`" + DomUtils.textContent(plainTextBody).trim() + "` ";
                }
                return;
            }
            if (n.type === "text" || n.type === "cdata") {
                const data = cleanText(n.data.trim());
                if (data) cellText += data + " ";
            } else if (n.type === "tag") {
                DomUtils.getChildren(n).forEach(recurse);
            }
        }
        DomUtils.getChildren(node).forEach(recurse);
        return cellText.replace(/\s+/g, " ").trim();
    }

    function cleanText(text:any) {
        return text
            .replace(/:[a-zA-Z0-9_]+:/g, "")  // Remove emoji shortcodes (e.g., :bird:)
            .replace(/\b1f[0-9a-fA-F]{3}\b/g, "") // Remove Unicode emoji codes (e.g., 1f426)
            .replace(/[🐦🐤🐥🕑👀🦉🦜🦢🦩🦚]/g, "") // Remove common emoji symbols
            .replace(/#[0-9A-Fa-f]{6}/g, "") // Remove hex color codes (e.g., #4C9AFF)
            .replace(/\b\d+\b/g, "") // Remove isolated numbers
            .replace(/\s+/g, " ") // Remove excessive spaces
            .trim();
    }

    DomUtils.getChildren(document).forEach(traverse);
    return markdown.trim();
}

export { extractTextFromXML };