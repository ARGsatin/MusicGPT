export type OpenEndedReplyKind = "chat" | "comment" | "dj";

export interface OpenEndedReplyAssessmentOptions {
  kind: OpenEndedReplyKind;
  recentReplies: string[];
}

export interface OpenEndedReplyAssessment {
  accepted: boolean;
  issues: string[];
}

export interface OpenEndedReplyRejection {
  draft: string;
  issues: string[];
}

export class OpenEndedReplyRejectedError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`open_ended_reply_rejected:${issues.join(",")}`);
    this.name = "OpenEndedReplyRejectedError";
    this.issues = issues;
  }
}

const CANNED_REVIEW_PATTERNS = [
  /把节奏和声音放得很舒服/u,
  /情绪刚刚好/u,
  /陪你听着一点也不累/u,
  /编曲不挤/u,
  /旋律又有小钩子/u,
  /越听越顺耳的那种/u,
  /我喜欢它的分寸感/u,
  /把情绪放得很自然/u,
  /重点到了/u,
  /扑得太满/u
];

const MUSICAL_DETAIL_PATTERN =
  /钢琴|吉他|贝斯|低频|鼓|鼓点|鼓组|人声|和声|旋律|节奏|音色|音型|和弦|编曲|合成器|弦乐|管乐|拍点|速度|动态|间奏|前奏|副歌|主歌|采样|混响|断句/u;

export function assessOpenEndedReply(
  text: string,
  options: OpenEndedReplyAssessmentOptions
): OpenEndedReplyAssessment {
  const normalized = text.trim();
  const issues: string[] = [];
  if (!normalized) {
    issues.push("empty");
  }
  if (CANNED_REVIEW_PATTERNS.some((pattern) => pattern.test(normalized))) {
    issues.push("canned_language");
  }
  if (options.kind === "comment" && normalized && !MUSICAL_DETAIL_PATTERN.test(normalized)) {
    issues.push("abstract_comment");
  }
  if (
    [...normalized].length >= 20 &&
    options.recentReplies.some((recent) => replySimilarity(normalized, recent) >= 0.72)
  ) {
    issues.push("recent_duplicate");
  }
  return {
    accepted: issues.length === 0,
    issues
  };
}

export async function generateAcceptedOpenEndedReply(
  generate: (rejection?: OpenEndedReplyRejection) => Promise<string>,
  options: OpenEndedReplyAssessmentOptions
): Promise<string> {
  let rejection: OpenEndedReplyRejection | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const draft = (await generate(rejection)).trim();
    const assessment = assessOpenEndedReply(draft, options);
    if (assessment.accepted) {
      return draft;
    }
    rejection = { draft, issues: assessment.issues };
  }
  throw new OpenEndedReplyRejectedError(rejection?.issues ?? ["empty"]);
}

function replySimilarity(left: string, right: string): number {
  const leftNgrams = trigrams(normalizeForComparison(left));
  const rightNgrams = trigrams(normalizeForComparison(right));
  if (leftNgrams.size === 0 || rightNgrams.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const ngram of leftNgrams) {
    if (rightNgrams.has(ngram)) {
      overlap += 1;
    }
  }
  return (2 * overlap) / (leftNgrams.size + rightNgrams.size);
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/《[^》]*》/gu, "《曲目》")
    .replace(
      /(《曲目》)\s*(?:—|-)\s*[^：:，。！？!?]+(?=[：:，。！？!?]|$)/gu,
      "$1—艺人"
    )
    .replace(/由[^，。！？!?：:]{1,40}(?=演唱|创作|制作)/gu, "由艺人")
    .replace(/\s+|[，。！？；：、,.!?;:~～—\-"'“”‘’（）()[\]{}]/gu, "");
}

function trigrams(text: string): Set<string> {
  const chars = [...text];
  if (chars.length < 3) {
    return new Set();
  }
  const output = new Set<string>();
  for (let index = 0; index <= chars.length - 3; index += 1) {
    output.add(chars.slice(index, index + 3).join(""));
  }
  return output;
}
