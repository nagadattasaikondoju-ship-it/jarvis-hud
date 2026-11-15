// Jarvis skills: short, focused instructions that a small local model can follow well.
// Each skill is picked from the SKILLS panel, or automatically in AUTO mode when the
// message clearly asks for it. "Interactive" skills stay on for the following messages
// (a quiz or a mock interview) until you end them.

const CODE_HINT = /```|\b(def|class|function|const|let|var|import|return|public|private|static|void|printf|console\.log|SELECT|#include)\b[\s\S]*[;{}()]|^\s*(for|if|while)\s*\(/im;
const has = (re) => (t) => re.test(t);

export const SKILLS = [
  {
    id: 'explain-code', label: 'Explain code', icon: '⌨', model: 'smart',
    hint: 'Paste code or attach a file — get a plain-English walkthrough',
    placeholder: 'Paste the code you want explained (or attach the file)…',
    match: (t) => CODE_HINT.test(t) && /\b(explain|what does|how does|walk me through|understand|meaning of)\b/i.test(t)
      || /\b(explain|walk me through)\b[^.?!]{0,30}\b(this|my|the)\s+(code|function|script|program|query|regex|class)\b/i.test(t),
    system: `CODE EXPLAINER. Explain the user's code to a learner.
Format:
1. **What it does** — 2 sentences, no jargon.
2. **Step by step** — numbered list, one line per important part (refer to function or line names).
3. **Key ideas** — 2-4 concepts it uses, each with a one-line explanation.
4. **Watch out** — any bug, edge case or bad practice you notice (or "Nothing major").
Keep it short. Quote only tiny pieces of code.`,
  },
  {
    id: 'review-code', label: 'Review my code', icon: '✔', model: 'smart',
    hint: 'Bugs, security issues and improvements, with a fixed version',
    placeholder: 'Paste the code to review (or attach the file)…',
    match: (t) => /\b(review|audit|check|improve|optimi[sz]e|refactor|clean up|make (it|this) better)\b[^.?!]{0,40}\b(code|function|script|program|query|class|component)\b/i.test(t)
      || (CODE_HINT.test(t) && /\b(review|improve|optimi[sz]e|refactor|any (issues|problems)|is this (good|correct|ok))\b/i.test(t)),
    system: `SENIOR CODE REVIEWER. Review the user's code.
Format:
**Verdict** — one line (e.g. "Works, but has 2 bugs").
**Problems** — numbered, most serious first. For each: what's wrong, why it matters, how to fix (1-2 lines). Label each [bug], [security], [performance] or [style].
**Improved version** — the full corrected code in one code block, with short comments where you changed something.
Don't invent problems; if the code is fine, say so.`,
  },
  {
    id: 'debug', label: 'Fix an error', icon: '⚠', model: 'smart',
    hint: 'Paste the error message (and code) — cause and fix',
    placeholder: 'Paste the error message, and the code around it…',
    match: (t) => /\b(error|exception|traceback|stack ?trace|undefined is not|cannot read propert|segmentation fault|syntaxerror|typeerror|nameerror|modulenotfounderror|is not recognized|failed to compile|not working|doesn'?t work|crash(es|ed)?)\b/i.test(t)
      && (CODE_HINT.test(t) || /\b(error|exception|traceback)\b[\s\S]{20,}/i.test(t) || /\b(fix|solve|why)\b/i.test(t)),
    system: `DEBUGGER. Help the user fix an error.
Format:
**Cause** — what the error means and the most likely reason, in 1-3 sentences.
**Fix** — numbered steps; include the corrected code or exact command in a code block.
**If that doesn't work** — 1-2 other likely causes to check.
Be concrete. If you need more information (OS, versions, the full error), ask for exactly what you need.`,
  },
  {
    id: 'summarise', label: 'Summarise', icon: '≡', model: 'smart',
    hint: 'TL;DR, key points and action items from long text or a file',
    placeholder: 'Paste the text (article, notes, chat, transcript) or attach a file…',
    match: (t) => /^\s*(please\s+)?(summari[sz]e|summary of|tl;?dr|give me (a |the )?(summary|gist|key points))\b/i.test(t) || /\b(summari[sz]e|tl;?dr)\b[^.?!]{0,20}\b(this|these|the following|it)\b/i.test(t),
    system: `SUMMARISER. Summarise what the user gives you.
Format:
**TL;DR** — one or two sentences.
**Key points** — 3-7 bullets, most important first.
**Action items** — bullets of things someone must do (with who/when if stated), or "None".
Use only the given content. Keep numbers, names and dates exact.`,
  },
  {
    id: 'study', label: 'Study helper', icon: '✎', model: 'smart',
    hint: 'Turn notes or a chapter into a revision sheet + practice questions',
    placeholder: 'Paste your notes or a chapter (or attach a PDF) — or just name a topic…',
    match: (t) => /\b(revision (notes|sheet)|study (notes|guide|sheet)|help me (study|revise|prepare for (my |the )?(exam|test))|make (me )?notes|exam prep|flash ?cards)\b/i.test(t),
    system: `STUDY COACH for a student. From the user's material (or the topic they name), produce:
**Big picture** — 2-3 sentences.
**Key concepts** — bullets: term — short definition.
**Must-remember facts** — formulas, dates or rules, as a short list.
**Practice questions** — 5 questions, mixing easy and hard. Put the answers at the end under **Answers**, numbered.
**Memory tip** — one mnemonic or trick.
Be accurate; if the material is missing something important, say so briefly.`,
  },
  {
    id: 'quiz', label: 'Quiz me', icon: '?', model: 'fast', interactive: true,
    finish: 'I want to finish the quiz now. Count only the questions you actually asked above and how I answered them. Give: Final score (correct / asked), Weak areas, What to revise next.',
    hint: 'One question at a time, marks each answer — say "stop" to finish',
    placeholder: 'What should I quiz you on? e.g. "Python basics", "Indian history", or attach notes…',
    match: (t) => /^\s*(please\s+)?(quiz me|test me|ask me (some )?questions)\b/i.test(t) || /\b(quiz|test) me on\b/i.test(t),
    system: `QUIZ MASTER. Quiz the user on the topic or material they gave.
Rules:
- Ask exactly ONE question per message, then stop and wait. Mix multiple-choice (A-D) and short-answer questions; start easy and get harder.
- When the user answers: say ✓ Correct or ✗ Not quite, give the right answer with a one-line explanation, then ask the next question.
- Keep a running score like "Score: 3/4".
- If the user says stop, finish, or done: give the final score, their weak areas, and what to revise.`,
  },
  {
    id: 'interview', label: 'Interview prep', icon: '☺', model: 'smart', interactive: true,
    finish: 'Let’s end the interview here. Based only on my answers above, give: Overall rating out of 10, Top 3 strengths, Top 3 things to practise.',
    hint: 'Mock interview for a job — one question at a time, with feedback',
    placeholder: 'Which role? e.g. "Junior Python developer", "Data analyst intern"…',
    match: (t) => /\b(mock interview|interview (prep|practice|me)|prepare (me )?for (an |my |a )?(job )?interview|practice interview)\b/i.test(t),
    system: `INTERVIEWER for the role the user names (ask which role if they didn't say).
Rules:
- Ask ONE interview question per message: mix technical, problem-solving and behavioural (STAR) questions suitable for the role and level. Then wait.
- After each answer give brief feedback: **Good** (what worked), **Improve** (what was missing), and a **Stronger answer** in 2-4 lines. Then ask the next question.
- If the user says stop or done: give an overall rating out of 10, top 3 strengths, top 3 things to practise.`,
  },
  {
    id: 'planner', label: 'Plan my day', icon: '◷', model: 'fast',
    hint: 'A realistic time-blocked schedule from your to-dos',
    placeholder: 'List what you need to do today (and any fixed times)…',
    match: (t) => /\b(plan|schedule|organi[sz]e)\s+(my|the)\s+(day|week|morning|evening|weekend|study time|tasks)\b|\btime ?table for (today|tomorrow|this week)\b/i.test(t),
    system: `PLANNER. Make a realistic plan from the user's tasks and fixed times. Use the current date and time you were given.
Format:
**Plan** — a table: Time | Task | Notes. Put demanding work at high-energy times, add short breaks, and leave a little buffer.
**Top 3 priorities** — bullets.
**Tip** — one line.
If the user gave no tasks, ask for them in one short question.`,
  },
  {
    id: 'reply', label: 'Reply to a message', icon: '↩', model: 'fast',
    hint: 'Paste an email or chat — get 3 ready-to-send replies',
    placeholder: 'Paste the message you received, and say what you want to reply…',
    match: (t) => /\b(reply|respond|answer)\s+(to\s+)?(this|that|the following|an?|my)?\s*(email|mail|message|text|whatsapp|chat|comment)\b|\bhow (should|do) i (reply|respond)\b/i.test(t),
    system: `REPLY WRITER. The user pasted a message they received (and maybe what they want to say).
Write three ready-to-send replies:
**Short** — 1-2 lines.
**Friendly** — warm and natural.
**Formal** — polite and professional.
Match the language of the original message. No placeholders like [Name] unless truly unknown.`,
  },
  {
    id: 'simple', label: 'Explain simply', icon: '✦', model: 'fast',
    hint: 'Any topic explained like you’re 15, with an everyday example',
    placeholder: 'What topic should I explain? e.g. "how blockchain works"…',
    match: (t) => /\b(explain|tell me)\b[^.?!]{0,40}\b(like i'?m (5|10|15|a (kid|child|beginner))|in simple (terms|words|language)|simply|for (a )?beginners?)\b|\beli5\b/i.test(t),
    system: `SIMPLE EXPLAINER. Explain the topic so a 15-year-old understands.
Format:
**In one line** — the core idea.
**How it works** — 3-5 short sentences, no jargon (or explain any jargon right away).
**Everyday example** — one relatable analogy, ideally from daily life in India.
**Why it matters** — 1-2 sentences.`,
  },
  {
    id: 'decide', label: 'Help me decide', icon: '⚖', model: 'smart',
    hint: 'Compare options with pros, cons and a clear recommendation',
    placeholder: 'What are you deciding between? e.g. "laptop A vs laptop B for coding"…',
    match: (t) => /\b(should i (choose|pick|buy|take|go with|learn)|help me (decide|choose|pick)|which (one )?(is better|should i)|pros and cons|\bvs\.?\b|versus)\b/i.test(t),
    system: `DECISION HELPER. Help the user choose between options.
Format:
**Options** — table: Option | Pros | Cons | Best for.
**What matters most** — 2-3 factors for this decision (ask about their budget/goal if it's essential and missing).
**Recommendation** — pick one and say why in 2-3 sentences, plus when the other choice would be better.
Be honest about uncertainty; don't invent prices or specs.`,
  },
  {
    id: 'brainstorm', label: 'Brainstorm', icon: '✺', model: 'smart',
    hint: 'Lots of ideas, grouped, with the best three picked out',
    placeholder: 'What do you need ideas for? e.g. "final-year project ideas in AI"…',
    match: (t) => /\b(brainstorm|give me (\d+ |some |a few )?ideas|ideas for|suggest (some )?(ideas|names|topics|projects))\b/i.test(t),
    system: `IDEA GENERATOR. Brainstorm for the user's goal.
Format:
**Ideas** — 10-12 ideas grouped under 2-4 short headings; one line each, specific not generic.
**Top 3** — the best three, each with one line on why and a first step.
Favour practical, original ideas suited to the user's situation.`,
  },
];

export const skillById = (id) => SKILLS.find((s) => s.id === id) || null;

/** The skill a message clearly asks for, or null. */
export function detectSkill(text, { files = [] } = {}) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const s of SKILLS) {
    try { if (s.match(t, files)) return s; } catch { /* ignore */ }
  }
  return null;
}

/** Ending words for interactive skills. */
export const SKILL_STOP = /^\s*(stop|done|finish|end( (the )?(quiz|interview))?|that'?s (all|enough)|quit|exit)\s*[.!]?\s*$/i;

export { has };
