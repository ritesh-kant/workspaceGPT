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
  // Per question: the picked option labels (OTHER stands for the text box).
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ''));

  const answerFor = (i: number, picks = picked[i], otherText = other[i]): string =>
    picks
      .map((p) => (p === OTHER ? otherText.trim() : p))
      .filter(Boolean)
      .join(', ');
  const complete = questions.every((_, i) => answerFor(i).length > 0);

  const send = (picks = picked) => {
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
    // One single-choice question: the click IS the answer, no extra Submit.
    if (questions.length === 1 && !q.multiSelect && label !== OTHER) send(next);
  };

  const decided = !!review.decision || !!review.applying;

  return (
    <div className='agent-write-card agent-question-card' data-review-id={review.id}>
      <div className='agent-write-header'>
        <span className='agent-write-kind kind-question'>Question</span>
        <span className='agent-question-headers'>{review.path}</span>
      </div>
      {decided ? (
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
      ) : (
        <>
          {questions.map((q, qi) => (
            <div key={qi} className='agent-question'>
              <div className='agent-question-text'>{q.question}</div>
              <div className='agent-question-options' role={q.multiSelect ? 'group' : 'radiogroup'}>
                {q.options.map((o) => {
                  const on = picked[qi].includes(o.label);
                  return (
                    <button
                      key={o.label}
                      type='button'
                      role={q.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={on}
                      className={`agent-question-option${on ? ' is-picked' : ''}`}
                      onClick={() => choose(qi, o.label)}
                    >
                      <span className='agent-question-option-label'>{o.label}</span>
                      {o.description && <span className='agent-question-option-desc'>{o.description}</span>}
                    </button>
                  );
                })}
                <label className={`agent-question-other${picked[qi].includes(OTHER) ? ' is-picked' : ''}`}>
                  <input
                    type='text'
                    placeholder='Other — type your own answer'
                    value={other[qi]}
                    onFocus={() => !picked[qi].includes(OTHER) && choose(qi, OTHER)}
                    onChange={(e) => setOther(other.map((t, i) => (i === qi ? e.target.value : t)))}
                    onKeyDown={(e) => e.key === 'Enter' && complete && send()}
                  />
                </label>
              </div>
            </div>
          ))}
          <div className='agent-write-actions' data-review-actions={review.id}>
            <button type='button' className='agent-write-approve' disabled={!complete} onClick={() => send()}>
              Send answer
            </button>
            <button
              type='button'
              className='agent-write-reject-open'
              title='Let the agent go ahead with its recommended option'
              onClick={skip}
            >
              Skip
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default AgentQuestionCard;
