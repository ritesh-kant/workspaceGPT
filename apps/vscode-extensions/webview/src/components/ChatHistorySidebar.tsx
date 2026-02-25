import React from 'react';
import './ChatHistorySidebar.css';

interface ChatSessionPreview {
    id: string;
    title: string;
    updatedAt: number;
}

interface ChatHistorySidebarProps {
    isVisible: boolean;
    historyList: ChatSessionPreview[];
    currentSessionId: string | null;
    onSelectSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string) => void;
    onClose: () => void;
    onNewChat: () => void;
}

const ChatHistorySidebar: React.FC<ChatHistorySidebarProps> = ({
    isVisible,
    historyList,
    currentSessionId,
    onSelectSession,
    onDeleteSession,
    onClose,
    onNewChat,
}) => {
    if (!isVisible) return null;

    const formatDate = (timestamp: number) => {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString();
    };

    return (
        <div className="history-overlay">
            <div className="history-sidebar">
                <div className="history-header">
                    <h3>Chat History</h3>
                    <div className="history-header-actions">
                        <button
                            className="history-new-chat-btn"
                            onClick={onNewChat}
                            title="New Chat"
                        >
                            +
                        </button>
                        <button
                            className="history-close-btn"
                            onClick={onClose}
                            title="Close"
                        >
                            ✕
                        </button>
                    </div>
                </div>
                <div className="history-list">
                    {historyList.length === 0 ? (
                        <div className="history-empty">
                            <span className="history-empty-icon">💬</span>
                            <p>No chats yet</p>
                            <p className="history-empty-subtitle">
                                Start a conversation to see it here
                            </p>
                        </div>
                    ) : (
                        historyList.map((session) => (
                            <div
                                key={session.id}
                                className={`history-item ${session.id === currentSessionId ? 'history-item-active' : ''
                                    }`}
                                onClick={() => onSelectSession(session.id)}
                            >
                                <div className="history-item-content">
                                    <span className="history-item-title">{session.title}</span>
                                    <span className="history-item-date">
                                        {formatDate(session.updatedAt)}
                                    </span>
                                </div>
                                <button
                                    className="history-item-delete"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDeleteSession(session.id);
                                    }}
                                    title="Delete chat"
                                >
                                    🗑
                                </button>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};

export default ChatHistorySidebar;
