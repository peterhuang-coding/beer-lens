"use client";

import { ChangeEvent, FormEvent, useMemo, useRef, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type Candidate = {
  candidateId: string;
  menuIndex: number;
  displayName: string;
  brewery: string;
  style: string;
  abv: number;
  hops: string[];
  worthScore: number;
  fitScore: number;
  reason: string;
  riskFlags: string[];
};

type AgentResponse = {
  reply: string;
  candidates: Candidate[];
  profileSummary: string;
};

const starterMessages: ChatMessage[] = [
  {
    role: "assistant",
    content:
      "把酒单照片、酒标照片、酒名，或者一句“今天想喝清爽的”发给我。我会给你 top picks，喝完再用 5 秒 benchmark 帮你记入口味库。"
  }
];

const quickPrompts = [
  "这张酒单帮我选，今天想喝清爽一点，不要太苦",
  "我只能喝一杯，帮我选最值得的",
  "想尝新，但不要太酸",
  "我喝了 Green City，4.5 分，会再喝，热带水果，顺滑，后段有点甜"
];

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>(starterMessages);
  const [input, setInput] = useState("");
  const [image, setImage] = useState<{ name: string; type: string; dataUrl: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [profileSummary, setProfileSummary] = useState("还没有正式记录，先用冷启动口味推荐。");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const topCandidate = useMemo(() => candidates[0], [candidates]);

  async function submitPrompt(prompt: string) {
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: prompt }];
    setMessages(nextMessages);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          messages: nextMessages,
          image: image
            ? {
                name: image.name,
                type: image.type,
                dataUrl: image.dataUrl
              }
            : undefined
        })
      });

      if (!response.ok) {
        throw new Error(`Agent failed: ${response.status}`);
      }

      const result = (await response.json()) as AgentResponse;
      setCandidates(result.candidates);
      setProfileSummary(result.profileSummary);
      setMessages([...nextMessages, { role: "assistant", content: result.reply }]);
      setImage(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent error";
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: `我这边 agent 路由出错了：${message}`
        }
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = input.trim() || (image ? "这张酒单帮我看下，按我的口味推荐" : "");
    if (!prompt || isLoading) return;
    void submitPrompt(prompt);
  }

  function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      setImage({
        name: file.name,
        type: file.type,
        dataUrl: String(reader.result)
      });
    };
    reader.readAsDataURL(file);
  }

  return (
    <main className="agent-shell">
      <section className="agent-main" aria-label="Beer Agent chat">
        <header className="agent-header">
          <div>
            <p className="eyebrow">Beer Lens Agent</p>
            <h1>把酒单发来，我直接告诉你该喝什么。</h1>
          </div>
          <p>
            当前是本地 mock brain。后续接入你的 API 后，这里会走真实 OCR、酒款检索、附近酒吧和个人偏好排序。
          </p>
        </header>

        <div className="chat-panel">
          <div className="message-list" aria-live="polite">
            {messages.map((message, index) => (
              <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
                <span>{message.role === "assistant" ? "Agent" : "You"}</span>
                <p>{message.content}</p>
              </article>
            ))}
            {isLoading ? (
              <article className="message assistant">
                <span>Agent</span>
                <p>我在读你的输入、匹配候选酒、更新推荐理由...</p>
              </article>
            ) : null}
          </div>

          <div className="quick-row">
            {quickPrompts.map((prompt) => (
              <button key={prompt} onClick={() => void submitPrompt(prompt)} disabled={isLoading}>
                {prompt}
              </button>
            ))}
          </div>

          <form className="composer" onSubmit={handleSubmit}>
            <label className="image-picker">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleImageChange}
              />
              {image ? "已选图片" : "上传酒单"}
            </label>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="发酒单需求，或喝完反馈：4.2，会再喝，柑橘，顺滑，偏甜。"
            />
            <button disabled={isLoading} type="submit">
              发送
            </button>
          </form>
        </div>
      </section>

      <aside className="agent-side" aria-label="Agent state">
        <section className="side-card">
          <p className="eyebrow">Profile</p>
          <h2>口味记忆</h2>
          <p>{profileSummary}</p>
        </section>

        <section className="side-card">
          <p className="eyebrow">Top Pick</p>
          {topCandidate ? (
            <div className="top-pick">
              <strong>{topCandidate.displayName}</strong>
              <span>
                {topCandidate.brewery} · {topCandidate.style} · {topCandidate.abv}% ABV
              </span>
              <div className="score-grid compact">
                <div>
                  <span>Worth</span>
                  <strong>{topCandidate.worthScore}</strong>
                </div>
                <div>
                  <span>Fit</span>
                  <strong>{topCandidate.fitScore}</strong>
                </div>
              </div>
              <p>{topCandidate.reason}</p>
            </div>
          ) : (
            <p>发一张酒单或一句需求后，这里会显示当前最推荐的一杯。</p>
          )}
        </section>

        <section className="side-card">
          <p className="eyebrow">Candidates</p>
          <h2>候选酒</h2>
          <div className="candidate-list">
            {candidates.length === 0 ? (
              <p>等待输入。</p>
            ) : (
              candidates.map((candidate) => (
                <article className="candidate" key={candidate.candidateId}>
                  <div>
                    <strong>{candidate.displayName}</strong>
                    <span>{candidate.style}</span>
                  </div>
                  <span className="score-pill">{candidate.fitScore}</span>
                </article>
              ))
            )}
          </div>
        </section>
      </aside>
    </main>
  );
}
