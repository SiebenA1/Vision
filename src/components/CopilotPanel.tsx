import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Brain,
  Check,
  Circle,
  Loader2,
  PanelRightClose,
  Send,
  Settings2,
  Sparkles,
  Square,
} from 'lucide-react';
import { useAppStore } from '../state/store';
import { useLlmStore } from '../state/llmStore';
import { stopAgent } from '../services/agent';
import type { ChatMessage } from '../core/types';

interface CopilotPanelProps {
  onSend: (prompt: string) => void;
}

function AgentMark({ size = 28 }: { size?: number }) {
  return (
    <span className="agent-mark" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4L12 2.8Z" stroke="currentColor" strokeWidth="1.3" />
        <path d="m8.2 12 2.5 2.5 5.1-6.1" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    </span>
  );
}

function renderContent(content: string) {
  return content.split('\n').map((line, index) => {
    if (!line.trim()) return <div key={index} className="chat-line chat-line--empty" />;
    const chunks = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    return (
      <p key={index} className="chat-line">
        {chunks.map((chunk, chunkIndex) => {
          if (chunk.startsWith('**') && chunk.endsWith('**')) {
            return <strong key={chunkIndex}>{chunk.slice(2, -2)}</strong>;
          }
          if (chunk.startsWith('`') && chunk.endsWith('`')) {
            return <code key={chunkIndex}>{chunk.slice(1, -1)}</code>;
          }
          return <span key={chunkIndex}>{chunk}</span>;
        })}
      </p>
    );
  });
}

function Message({ message, onChip, busy }: { message: ChatMessage; onChip: (text: string) => void; busy: boolean }) {
  const isUser = message.role === 'user';
  const source = message.meta?.source;
  if (isUser) {
    return (
      <div className="chat-message chat-message--user">
        <div className="chat-message__bubble">{renderContent(message.content)}</div>
        <span className="chat-message__time">
          {new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    );
  }
  return (
    <div className={`chat-message chat-message--assistant chat-message--${source ?? 'local'}`}>
      <div className="chat-message__head">
        <AgentMark size={24} />
        <div>
          <b>{source === 'system' ? 'SYSTEM' : 'ATLAS'}</b>

        </div>
        <span className="chat-message__time">
          {new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div className="chat-message__body">
        {message.reasoning && (
          <details className="agent-reasoning">
            <summary>
              <Brain size={12} />
              {message.streaming ? '思考中…' : '模型思考过程'}
              <span>{message.reasoning.length.toLocaleString('en-US')} chars</span>
            </summary>
            <div className="agent-reasoning__body">{message.reasoning}</div>
          </details>
        )}
        {message.steps && message.steps.length > 0 && (
          <details className="agent-plan" open={message.streaming}><summary>{message.steps.some((step) => step.status === 'error') ? '操作未完成 · 查看详情' : message.streaming ? '正在执行操作…' : '查看操作详情'}</summary>
            {message.steps.map((step) => (
              <div key={step.id} className={`agent-step agent-step--${step.status}`}>
                <span className="agent-step__icon">
                  {step.status === 'running' ? (
                    <Loader2 size={12} className="spin" />
                  ) : step.status === 'done' ? (
                    <Check size={12} />
                  ) : step.status === 'error' ? (
                    <AlertTriangle size={12} />
                  ) : (
                    <Circle size={9} />
                  )}
                </span>
                <span className="agent-step__label">{step.label}</span>
                {step.detail && <span className="agent-step__detail">{step.detail}</span>}
              </div>
            ))}
          </details>
        )}
        {message.content && (
          <div className={`chat-message__content ${message.streaming ? 'is-streaming' : ''}`}>
            {renderContent(message.content)}
            {message.streaming && <span className="stream-caret" />}
          </div>
        )}
        {message.meta?.chips && (
          <div className="chat-chips">
            {message.meta.chips.map((chip) => (
              <button key={chip} type="button" onClick={() => onChip(chip)} disabled={busy}>
                {chip}
              </button>
            ))}
          </div>
        )}
        {message.usage && (
          <details className="chat-usage"><summary>调用信息</summary>
            <span>{message.meta?.model ?? 'DEEPSEEK'}</span>
            <span>{message.usage.totalTokens.toLocaleString('en-US')} tokens</span>
            {message.usage.reasoningTokens ? (
              <span>{message.usage.reasoningTokens.toLocaleString('en-US')} think</span>
            ) : null}
            {message.latencyMs ? <span>{message.latencyMs} ms</span> : null}
          </details>
        )}
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  { label: '运行校核', prompt: '运行一次基线校核，并解释结果。' },
  { label: '解释风险', prompt: '解释当前模型的主要风险和分析限制。' },
];

export function CopilotPanel({ onSend }: CopilotPanelProps) {
  const chat = useAppStore((state) => state.chat);
  const busy = useAppStore((state) => state.chatBusy);
  const agentSource = useAppStore((state) => state.agentSource);
  const copilotCollapsed = useAppStore((state) => state.copilotCollapsed);
  const toggleCopilot = useAppStore((state) => state.toggleCopilot);
  const model = useAppStore((state) => state.model);
  const llmSettings = useLlmStore((state) => state.settings);
  const serverKey = useLlmStore((state) => state.serverKey);
  const apiKeyPresent = useLlmStore((state) => state.apiKeyPresent);
  const llmConnectionStatus = useLlmStore((state) => state.connectionStatus);
  const openSettings = useLlmStore((state) => state.openSettings);
  const configured = serverKey || apiKeyPresent;
  const llmError = configured && llmConnectionStatus === 'error';
  const isBlankProject = (model.template ?? 'bracket') === 'empty';
  const streamingDeepSeek = busy && agentSource === 'deepseek';
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chat]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (copilotCollapsed) {
          toggleCopilot();
          window.setTimeout(() => inputRef.current?.focus(), 0);
        } else inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [copilotCollapsed, toggleCopilot]);

  if (copilotCollapsed) {
    return (
      <button type="button" className="copilot-rail" onClick={toggleCopilot} title="展开工程智能体">
        <AgentMark size={26} />
        <span>ATLAS</span>
        <span className={`copilot-rail__state ${configured ? 'is-live' : ''}`} />
        <span className="copilot-rail__line" />
        <span className="copilot-rail__hint">⌘K</span>
      </button>
    );
  }

  const submit = () => {
    const value = draft.trim();
    if (!value || busy) return;
    setDraft('');
    onSend(value);
  };

  return (
    <aside className="copilot">
      <div className="copilot__head">
        <div className="copilot__identity">
          <AgentMark size={30} />
          <div>
            <div className="copilot__name">
              ATLAS
            </div>
            <span className="copilot__sub">
              {llmError
                ? '上次调用失败 · 点击检查 API Key / 网关'
                : configured
                  ? '建模与工程分析'
                  : '配置 AI 后开始建模'}
            </span>
          </div>
        </div>
        <div className="copilot__head-actions">
          <button type="button" className="icon-button icon-button--small" onClick={openSettings} title="DeepSeek 设置">
            <Settings2 size={15} />
          </button>
          <button type="button" className="icon-button icon-button--small" onClick={toggleCopilot} title="收起智能体">
            <PanelRightClose size={15} />
          </button>
        </div>
      </div>

      <div className="copilot__scroll" ref={scrollRef}>
        {chat.map((message) => (
          <Message key={message.id} message={message} onChip={onSend} busy={busy} />
        ))}

        {chat.length <= 1 && !isBlankProject && (
          <div className="suggestion-block">
            {!configured && (
              <button type="button" className="llm-setup-banner" onClick={openSettings}>
                <span className="llm-setup-banner__icon"><Sparkles size={15} /></span>
                <span>
                  <b>启用 DeepSeek 大模型</b>
                  <small>流式输出 · 思考模式 · 工具调用</small>
                </span>
                <ArrowUp size={12} />
              </button>
            )}

            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion.label} type="button" onClick={() => onSend(suggestion.prompt)} disabled={busy}>
                <span>{suggestion.label}</span>
                <ArrowUp size={12} />
              </button>
            ))}
          </div>
        )}

        {chat.length <= 1 && isBlankProject && (
          <div className="blank-copilot-hint">
            <span className="blank-copilot-hint__mark">V</span>
            <div>
              <span className="eyebrow">BLANK PROJECT</span>
              <b>描述你要设计的零件</b>
              <p>例如：创建一块长 100、宽 50、厚 8 mm 的板，中心开直径 12 mm 的通孔。</p>
            </div>
          </div>
        )}

        {busy && (
          <div className="agent-thinking">
            <span />
            <span />
            <span />
            <small>{streamingDeepSeek ? 'DEEPSEEK 正在推理 / 调用工具' : 'ATLAS 正在编排工具调用'}</small>
          </div>
        )}
      </div>

      <div className="copilot__composer">
        <div className={`composer-box ${busy ? 'is-busy' : ''}`}>
          <textarea
            id="copilot-input"
            ref={inputRef}
            value={draft}
            rows={2}
            aria-label="工程需求"
            placeholder="描述零件、尺寸或需要修改的内容…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            disabled={busy}
          />
          <div className="composer-box__footer">
            <span>
              <Sparkles size={12} /> 受控工具 · 可撤销
            </span>
            {streamingDeepSeek ? (
              <button type="button" className="send-button send-button--stop" onClick={stopAgent} aria-label="停止生成">
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button type="button" className="send-button" onClick={submit} disabled={!draft.trim() || busy} aria-label="发送">
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="composer-note">
          Enter 发送 · Shift+Enter 换行
        </div>
      </div>
    </aside>
  );
}
