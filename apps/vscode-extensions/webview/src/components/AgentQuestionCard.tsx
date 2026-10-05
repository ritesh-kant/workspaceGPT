import React, { useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { useChatStore, WriteReview } from '../store/chatStore';

/**
 * The ask_user card: the agent's question as clickable options plus a free
 * "Other" answer. The run is parked on it host-side (same gate as a write
 * review), so answering is what lets the agent continue; Skip tells it to go
 * ahead on its recommended option and say so.
 */

interface AgentQuestionCardProps {
  review: WriteReview;
  onDecided: (id: string, decision: 'approved' | 'rejected') => void;
}

const OTHER = '\u0000other';

const AgentQuestionCard: React.FC<AgentQuestionCardProps> = ({ review, onDecided }) => {
  const vscode = VSCodeAPI();
  const questions = review.questions ?? [];
  const [activeIndex, setActiveIndex] = useState(0);
  // Per question: the picked option labels (OTHER stands for the text box).
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ''));

  const answerFor = (i: number, picks = picked[i], otherText = other[i]): string =>
    picks
      .map((p) => (p === OTHER ? otherText.trim() : p))
      .filter(Boolean)
      .join(', ');
  const send = (picks = picked) => {
    if (!questions.length || questions.some((_, i) => !answerFor(i, picks[i]))) return;
    const text =
      questions.length === 1
        ? answerFor(0, picks[0])
        : questions.map((q, i) => `${q.header || q.question}: ${answerFor(i, picks[i])}`).join('\n');
    vscode.postMessage({ type: MESSAGE_TYPES.AGENT_WRITE_DECISION, id: review.id, approved: true, feedback: text });
    useChatStore.getState().setWriteReviewAnswer(review.id, text);
    onDecided(review.id, 'approved');
  };

  const skip = () => {
    vscode.postMessage({ type: MESSAGE_TYPES.AGENT_WRITE_DECISION, id: review.id, approved: false });
    onDecided(review.id, 'rejected');
  };

  const advance = (picks = picked, otherText = other[activeIndex]) => {
    if (!answerFor(activeIndex, picks[activeIndex], otherText)) return;
    if (activeIndex < questions.length - 1) {
      setActiveIndex(activeIndex + 1);
      return;
    }
    // Navigation can skip a question. Return to the first unanswered one
    // before submitting the batch to the agent.
    const unanswered = questions.findIndex((_, i) => !answerFor(i, picks[i], i === activeIndex ? otherText : other[i]));
    if (unanswered >= 0) setActiveIndex(unanswered);
    else send(picks);
  };

  const choose = (qi: number, label: string) => {
    const q = questions[qi];
    const current = picked[qi];
    const nextPicks = q.multiSelect
      ? current.includes(label)
        ? current.filter((p) => p !== label)
        : [...current, label]
      : [label];
    const next = picked.map((p, i) => (i === qi ? nextPicks : p));
    setPicked(next);
    if (!q.multiSelect && label !== OTHER) advance(next);
  };

  const decided = !!review.decision || !!review.applying;
  const activeQuestion = questions[activeIndex];
  const allAnswered = questions.every((_, i) => answerFor(i).length > 0);

  return (
    <div className='agent-write-card agent-question-card' data-review-id={review.id}>
      {decided ? (
        <>
          <div className='agent-write-header'>
            <span className='agent-write-kind kind-question'>Question</span>
            <span className='agent-question-headers'>{review.path}</span>
          </div>
          <div className='agent-question-answered'>
          {review.decision === 'rejected' ? (
            <span className='agent-question-skipped'>Skipped — the agent went with its recommendation</span>
          ) : review.decision === 'stopped' ? (
            <span className='agent-question-skipped'>Not answered — run stopped</span>
          ) : (
            <>
              <span className='agent-question-check'>✓</span> {review.answer || 'Answered'}
            </>
          )}
          </div>
        </>
      ) : (
        <>
          {activeQuestion && (
            <div className='agent-question'>
              <div className='agent-question-heading'>
                <div className='agent-question-text'>{activeQuestion.question}</div>
                <div className='agent-question-navigation'>
                  <button type='button' className='agent-question-nav' aria-label='Previous question' title='Previous question' disabled={activeIndex === 0} onClick={() => setActiveIndex(activeIndex - 1)}>
                    <svg viewBox='0 0 16 16' aria-hidden='true'><path d='m10 3-5 5 5 5' /></svg>
                  </button>
                  <span className='agent-question-progress'>{activeIndex + 1}/{questions.length}</span>
                  <button type='button' className='agent-question-nav' aria-label='Next question' title='Next question' disabled={activeIndex === questions.length - 1} onClick={() => setActiveIndex(activeIndex + 1)}>
                    <svg viewBox='0 0 16 16' aria-hidden='true'><path d='m6 3 5 5-5 5' /></svg>
                  </button>
                </div>
              </div>
              <div className='agent-question-options' role={activeQuestion.multiSelect ? 'group' : 'radiogroup'} aria-label={activeQuestion.question}>
                {activeQuestion.options.map((o, oi) => {
                  const on = picked[activeIndex].includes(o.label);
                  return (
                    <button
                      key={o.label}
                      type='button'
                      role={activeQuestion.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={on}
                      className={`agent-question-option${on ? ' is-picked' : ''}`}
                      onClick={() => choose(activeIndex, o.label)}
                    >
                      <span className='agent-question-option-copy'>
                        <span className='agent-question-option-label'>{o.label}</span>
                        {o.description && <span className='agent-question-option-desc'>{o.description}</span>}
                      </span>
                      <span className='agent-question-option-number' aria-hidden='true'>{oi + 1}</span>
                    </button>
                  );
                })}
                <label className={`agent-question-other${picked[activeIndex].includes(OTHER) ? ' is-picked' : ''}`}>
                  <input
                    type='text'
                    placeholder='Type something else...'
                    aria-label='Type something else'
                    value={other[activeIndex]}
                    onFocus={() => !picked[activeIndex].includes(OTHER) && choose(activeIndex, OTHER)}
                    onChange={(e) => setOther(other.map((t, i) => (i === activeIndex ? e.target.value : t)))}
                    onKeyDown={(e) => e.key === 'Enter' && advance()}
                  />
                  <span className='agent-question-option-number' aria-hidden='true'>{activeQuestion.options.length + 1}</span>
                </label>
              </div>
            </div>
          )}
          <div className='agent-write-actions' data-review-actions={review.id}>
            <button
              type='button'
              className='agent-write-reject-open'
              title='Let the agent go ahead with its recommended option'
              onClick={skip}
            >
              Skip
            </button>
            {(activeQuestion?.multiSelect || picked[activeIndex]?.includes(OTHER) || (activeIndex === questions.length - 1 && allAnswered)) && (
              <button type='button' className='agent-question-next' disabled={!answerFor(activeIndex)} onClick={() => advance()}>
                {activeIndex === questions.length - 1 && allAnswered ? 'Send answer' : 'Continue'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default AgentQuestionCard;
