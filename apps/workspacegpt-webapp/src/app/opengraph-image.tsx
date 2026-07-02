import { ImageResponse } from "next/og";

export const alt =
  "WorkspaceGPT — Local, Private AI Coding Assistant for VS Code & Cursor";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          background: "#030712",
          backgroundImage:
            "radial-gradient(circle at 30% 20%, rgba(31,242,180,0.15), transparent 45%), radial-gradient(circle at 75% 80%, rgba(59,130,246,0.18), transparent 45%)",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "8px 24px",
            borderRadius: 9999,
            border: "1px solid rgba(31,242,180,0.3)",
            background: "rgba(31,242,180,0.08)",
            color: "#1ff2b4",
            fontSize: 28,
            marginBottom: 40,
          }}
        >
          100% Local &amp; Private
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 84,
            fontWeight: 800,
            color: "white",
            letterSpacing: -2,
          }}
        >
          WorkspaceGPT
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 38,
            color: "#94a3b8",
            marginTop: 24,
            maxWidth: 900,
            textAlign: "center",
          }}
        >
          Your AI-powered local coding assistant for VS Code, Cursor &amp;
          Antigravity
        </div>
        <div
          style={{
            display: "flex",
            gap: 24,
            marginTop: 48,
            fontSize: 26,
            color: "#64748b",
          }}
        >
          <span>Codebase RAG</span>
          <span style={{ color: "#1ff2b4" }}>•</span>
          <span>Confluence</span>
          <span style={{ color: "#1ff2b4" }}>•</span>
          <span>Azure DevOps</span>
          <span style={{ color: "#1ff2b4" }}>•</span>
          <span>Ollama</span>
        </div>
      </div>
    ),
    size
  );
}
