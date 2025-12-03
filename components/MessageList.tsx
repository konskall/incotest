import React, { useState, useEffect } from 'react';
import { Message } from '../types';
import { getYouTubeId } from '../utils/helpers';
import { 
  FileText, Download, MoreVertical, Edit2, 
  File, FileAudio, FileVideo, FileCode, FileArchive, SmilePlus 
} from 'lucide-react';

interface MessageListProps {
  messages: Message[];
  currentUserUid: string;
  onEdit: (msg: Message) => void;
  onReact: (msg: Message, emoji: string) => void;
}

// -- Link Preview Component --
const LinkPreview: React.FC<{ url: string }> = ({ url }) => {
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        let isActive = true; 
        setLoading(true);
        setError(false);
        
        // Using microlink.io free API to fetch Open Graph data
        fetch(`https://api.microlink.io?url=${encodeURIComponent(url)}`)
            .then(res => res.json())
            .then(json => {
                if (isActive) {
                    if (json.status === 'success') {
                        setData(json.data);
                    } else {
                        setError(true);
                    }
                    setLoading(false);
                }
            })
            .catch(() => {
                if (isActive) {
                    setError(true);
                    setLoading(false);
                }
            });
            
        return () => { isActive = false; };
    }, [url]);

    if (loading) return null;
    if (error || !data) return null;

    // Don't show preview if title is missing or it's just the url
    if (!data.title || data.title === url) return null;

    return (
        <a 
            href={url} 
            target="_blank" 
            rel="noopener noreferrer" 
            className="block mt-2 bg-white/95 border border-black/10 rounded-lg overflow-hidden hover:bg-white transition-colors w-full max-w-[300px] shadow-sm text-slate-800 no-underline group/card"
        >
            {data.image?.url && (
                <div 
                    className="h-32 w-full bg-cover bg-center bg-no-repeat bg-slate-100" 
                    style={{backgroundImage: `url(${data.image.url})`}} 
                />
            )}
            <div className="p-3">
                <h3 className="font-bold text-sm truncate leading-tight group-hover/card:text-blue-600 transition-colors">{data.title}</h3>
                {data.description && (
                    <p className="text-xs text-slate-500 line-clamp-2 mt-1 leading-snug">{data.description}</p>
                )}
                <div className="flex items-center gap-1.5 mt-2">
                    {data.logo?.url && (
                        <img src={data.logo.url} loading="lazy" className="w-3.5 h-3.5 rounded-sm object-contain" alt="" />
                    )}
                    <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">
                        {data.publisher || new URL(url).hostname}
                    </span>
                </div>
            </div>
        </a>
    );
};

// Memoized Message Item to prevent re-renders of the whole list
const MessageItem = React.memo(({ msg, isMe, currentUid, onEdit, onReact }: { msg: Message; isMe: boolean; currentUid: string; onEdit: (msg: Message) => void; onReact: (msg: Message, emoji: string) => void }) => {
  const [showOptions, setShowOptions] = useState(false);
  const [showReactions, setShowReactions] = useState(false);

  const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

  const formatTime = (timestamp: any) => {
    if (!timestamp) return '...'; // Pending
    try {
        // Handle Firestore Timestamp (has .toDate()) or standard JS Date
        const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
        if (isNaN(date.getTime())) return '';
        
        return date.toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit', 
            hour12: false 
        });
    } catch (e) {
        return '';
    }
  };

  const timeString = formatTime(msg.createdAt);

  const renderContent = (text: string) => {
    if (!text) return null;

    const ytId = getYouTubeId(text);
    // Regex for parsing URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);

    // Identify the first non-YouTube URL to show a preview card for
    const matches = text.match(urlRegex);
    let previewUrl: string | null = null;
    
    if (matches && !ytId) {
        // Use the first link found for preview
        previewUrl = matches[0];
    }

    return (
        <div className="flex flex-col gap-2">
            {/* Render text with clickable links */}
            <span className="leading-relaxed whitespace-pre-wrap break-words">
                {parts.map((part, i) => {
                    if (part.match(urlRegex)) {
                        return (
                            <a 
                                key={i} 
                                href={part} 
                                target="_blank" 
                                rel="noopener noreferrer" 
                                className="underline text-inherit opacity-90 break-all hover:opacity-100"
                            >
                                {part}
                            </a>
                        );
                    }
                    return part;
                })}
            </span>

            {/* YouTube Embed */}
            {ytId && (
               <div className="relative w-full aspect-video rounded-lg overflow-hidden shadow-md bg-black/5 mt-1">
                    <iframe
                        className="absolute inset-0 w-full h-full"
                        src={`https://www.youtube.com/embed/${ytId}`}
                        title="YouTube video player"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                        loading="lazy"
                    ></iframe>
               </div>
            )}

            {/* General Link Preview (OG Data) */}
            {previewUrl && <LinkPreview url={previewUrl} />}
        </div>
    );
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType.startsWith('audio/')) return <FileAudio size={20} />;
    if (mimeType.startsWith('video/')) return <FileVideo size={20} />;
    if (mimeType.includes('pdf')) return <FileText size={20} />;
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('7z') || mimeType.includes('compressed')) return <FileArchive size={20} />;
    if (mimeType.includes('json') || mimeType.includes('javascript') || mimeType.includes('html') || mimeType.includes('css') || mimeType.includes('xml')) return <FileCode size={20} />;
    if (mimeType.includes('text/')) return <FileText size={20} />;
    return <File size={20} />;
  };

  const renderAttachment = () => {
    if (!msg.attachment) return null;

    const { url, name, type, size } = msg.attachment;
    const sizeKB = (size / 1024).toFixed(1);

    if (type.startsWith('image/')) {
        return (
            <div className="mt-2 mb-1 group/image relative">
                <a href={url} download={name} title="Click to download full size" className="block relative overflow-hidden rounded-lg">
                    <div className="absolute inset-0 bg-black/0 group-hover/image:bg-black/10 transition-colors z-10" />
                    <img 
                        src={url} 
                        alt={name} 
                        loading="lazy"
                        className="max-w-full rounded-lg shadow-sm border border-white/10 max-h-[300px] w-auto object-contain bg-black/5" 
                    />
                </a>
            </div>
        );
    }

    return (
        <a 
            href={url} 
            download={name}
            className={`flex items-center gap-3 p-3 mt-2 rounded-xl border transition-all group/file
            ${isMe 
                ? 'bg-white/10 border-white/20 hover:bg-white/20 text-white' 
                : 'bg-slate-50 border-slate-200 hover:bg-slate-100 text-slate-700'}`}
        >
            <div className={`p-2.5 rounded-lg flex-shrink-0 transition-colors
                ${isMe ? 'bg-white/20 text-blue-100' : 'bg-blue-100 text-blue-600'}`}>
                {getFileIcon(type)}
            </div>
            
            <div className="flex flex-col flex-1 min-w-0">
                <span className="text-sm font-semibold truncate leading-tight">{name}</span>
                <span className={`text-[10px] uppercase tracking-wider mt-0.5 ${isMe ? 'text-blue-100/70' : 'text-slate-400'}`}>
                    {sizeKB} KB • {type.split('/')[1]?.split(';')[0].toUpperCase() || 'FILE'}
                </span>
            </div>
            
            <div className={`p-1.5 rounded-full transition-opacity opacity-70 group-hover/file:opacity-100
                ${isMe ? 'hover:bg-white/20' : 'hover:bg-slate-200'}`}>
                <Download size={18} />
            </div>
        </a>
    );
  };

  return (
    <div className={`flex w-full mb-4 animate-in slide-in-from-bottom-2 duration-300 group ${isMe ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[85%] md:max-w-[70%] ${isMe ? 'flex-row-reverse' : 'flex-row'} items-end gap-2 relative`}>
        
        {/* Avatar */}
        <img 
            src={msg.avatarURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(msg.username)}&background=${isMe ? '3b82f6' : '64748b'}&color=fff&rounded=true`}
            alt={msg.username}
            loading="lazy"
            className="w-8 h-8 rounded-full shadow-sm object-cover border-2 border-white select-none bg-slate-200"
        />

        {/* Message Actions (Only for self) */}
        {isMe && (
            <div className={`relative transition-opacity flex flex-col justify-center ${showOptions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                <button 
                    onClick={() => setShowOptions(!showOptions)}
                    className="p-1.5 text-slate-400 hover:text-blue-500 hover:bg-slate-100 rounded-full transition"
                >
                    <MoreVertical size={16} />
                </button>
                {showOptions && (
                    <div className="absolute bottom-8 right-0 bg-white shadow-xl border border-slate-100 rounded-lg p-1 z-50 flex flex-col min-w-[120px] animate-in zoom-in-95 duration-100">
                        <button 
                            onClick={(e) => { e.stopPropagation(); onEdit(msg); setShowOptions(false); }}
                            className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-blue-50 hover:text-blue-600 rounded-md transition text-left"
                        >
                            <Edit2 size={14} /> Edit
                        </button>
                    </div>
                )}
                {/* Overlay to close menu when clicking outside */}
                {showOptions && (
                    <div className="fixed inset-0 z-40 cursor-default" onClick={() => setShowOptions(false)} />
                )}
            </div>
        )}

        {/* Reaction Button (Hidden by default, visible on hover or if reaction menu open) */}
        <div className={`relative flex items-center h-full self-center ${isMe ? 'mr-1' : 'ml-1'}`}>
             <button 
                onClick={() => setShowReactions(!showReactions)}
                className={`p-1 text-slate-400 hover:text-orange-500 rounded-full transition-all ${showReactions ? 'opacity-100 text-orange-500 bg-orange-50' : 'opacity-0 group-hover:opacity-100'}`}
             >
                <SmilePlus size={18} />
             </button>
             
             {showReactions && (
                 <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowReactions(false)} />
                    <div className={`absolute bottom-8 ${isMe ? 'right-0' : 'left-0'} flex gap-1 bg-white p-1.5 rounded-full shadow-xl border border-slate-100 z-50 animate-in zoom-in-95 duration-200`}>
                        {QUICK_REACTIONS.map(emoji => (
                            <button
                                key={emoji}
                                onClick={() => { onReact(msg, emoji); setShowReactions(false); }}
                                className="w-8 h-8 flex items-center justify-center text-lg hover:bg-slate-100 rounded-full transition hover:scale-125"
                            >
                                {emoji}
                            </button>
                        ))}
                    </div>
                 </>
             )}
        </div>

        {/* Bubble */}
        <div className={`relative flex flex-col min-w-0 ${isMe ? 'items-end' : 'items-start'}`}>
            <div className={`
                relative px-4 py-2.5 rounded-2xl shadow-sm text-sm md:text-base min-w-0
                ${isMe 
                    ? 'bg-blue-600 text-white rounded-br-none shadow-blue-500/20' 
                    : 'bg-white text-slate-800 rounded-bl-none shadow-slate-200 border border-slate-100'}
            `}>
                {!isMe && <p className="text-[10px] font-bold text-slate-400 mb-0.5 tracking-wide select-none">{msg.username}</p>}
                
                {/* Attachment Display */}
                {renderAttachment()}

                {/* Text Display */}
                {msg.text && (
                    <div className={`leading-relaxed whitespace-pre-wrap break-words ${msg.attachment ? 'mt-2 pt-2 border-t ' + (isMe ? 'border-white/20' : 'border-slate-100') : ''}`}>
                        {renderContent(msg.text)}
                    </div>
                )}

                {/* Timestamp & Edit Indicator */}
                <div className={`flex items-center justify-end gap-1 mt-1 select-none ${isMe ? 'text-blue-200' : 'text-slate-400'}`}>
                    {msg.isEdited && <span className="text-[9px] italic opacity-80">(edited)</span>}
                    <span className="text-[10px] font-medium">{timeString}</span>
                </div>
            </div>

            {/* Reactions Display */}
            {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                <div className={`flex flex-wrap gap-1 mt-1 ${isMe ? 'justify-end' : 'justify-start'}`}>
                    {Object.entries(msg.reactions).map(([emoji, uids]) => {
                        if (uids.length === 0) return null;
                        const iReacted = uids.includes(currentUid);
                        return (
                            <button 
                                key={emoji}
                                onClick={() => onReact(msg, emoji)}
                                className={`
                                    flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs shadow-sm border transition-all hover:scale-105
                                    ${iReacted 
                                        ? 'bg-blue-100 border-blue-200 text-slate-800' 
                                        : 'bg-white border-slate-200 text-slate-600'}
                                `}
                            >
                                <span>{emoji}</span>
                                <span className={`font-semibold text-[10px] ${iReacted ? 'text-blue-600' : 'text-slate-500'}`}>{uids.length}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
    // Custom comparison function for React.memo
    
    // Check basic primitives
    if (prevProps.isMe !== nextProps.isMe ||
        prevProps.msg.id !== nextProps.msg.id ||
        prevProps.msg.text !== nextProps.msg.text ||
        prevProps.msg.isEdited !== nextProps.msg.isEdited) {
        return false;
    }

    // Check attachment changes
    if (prevProps.msg.attachment !== nextProps.msg.attachment) {
         if (prevProps.msg.attachment?.url !== nextProps.msg.attachment?.url ||
             prevProps.msg.attachment?.name !== nextProps.msg.attachment?.name) {
             return false;
         }
    }

    // Check reactions
    // Simple JSON stringify comparison is usually fast enough for small reaction objects
    // If reactions changed, we MUST re-render
    if (JSON.stringify(prevProps.msg.reactions) !== JSON.stringify(nextProps.msg.reactions)) {
        return false;
    }

    // Check timestamp
    const getSeconds = (ts: any) => {
        if (!ts) return 0;
        if (ts.seconds) return ts.seconds;
        if (ts.toMillis) return ts.toMillis();
        return 0; 
    };

    const prevSeconds = getSeconds(prevProps.msg.createdAt);
    const nextSeconds = getSeconds(nextProps.msg.createdAt);
    
    if (prevSeconds !== nextSeconds) {
        return false;
    }

    return true;
});

const MessageList: React.FC<MessageListProps> = ({ messages, currentUserUid, onEdit, onReact }) => {
  return (
    <div className="flex flex-col justify-end min-h-full pb-2">
      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-slate-400 opacity-60">
            <p>No messages yet.</p>
            <p className="text-xs">Say hello! 👋</p>
        </div>
      ) : (
        messages.map((msg) => (
          <MessageItem 
            key={msg.id} 
            msg={msg} 
            isMe={msg.uid === currentUserUid}
            currentUid={currentUserUid}
            onEdit={onEdit}
            onReact={onReact}
          />
        ))
      )}
    </div>
  );
};

export default MessageList;
