/**
 * Fixed, reviewable acceptance corpus for the teachable-DJ intelligence seam.
 *
 * A trajectory is deliberately expressed only in terms of the two public command
 * channels and their observable response fields. It does not name parser or
 * ranking internals, so the corpus remains useful when those implementations move.
 */

const DIRECT_OR_COMPOUND_COMMAND = "direct_or_compound_command";
const REFERENCE_OR_CLARIFICATION = "reference_or_clarification";
const TEMPORARY_OR_LONG_TERM_CORRECTION = "temporary_or_long_term_correction";
const CONTEXTUAL_RECOMMENDATION = "contextual_recommendation";
const MULTI_SOURCE_OR_FAILURE = "multi_source_or_failure";

const commandCases = [
  ["暂停", "pause", "executed", ["command.actions", "now.track"]],
  ["继续播放", "resume", "executed", ["command.actions", "now.track"]],
  ["下一首", "skip", "executed", ["command.actions", "now.track"]],
  ["重播这首", "replay", "executed", ["command.actions", "now.track"]],
  ["收藏这首", "like", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["取消收藏", "unlike", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["现在放的是什么", "query_current", "answered", ["command.actions", "now.track"]],
  ["后面还有什么歌", "query_queue", "answered", ["command.actions", "now.queue"]],
  ["能听一首陈奕迅吗", "play_specific", "executed", ["command.actions", "now.track"]],
  ["播放《富士山下》", "play_specific", "executed", ["command.actions", "now.track"]],
  ["来一首适合写代码的歌", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["切到安静一点的音乐", "update_session_intent", "executed", ["command.actions", "now.track", "now.queue"]],
  ["接下来安静一点", "update_session_intent", "executed", ["command.actions", "now.track", "now.queue"]],
  ["换个不那么吵的", "update_session_intent", "executed", ["command.actions", "now.track", "now.queue"]],
  ["暂停后换一首适合工作的歌", "pause", "executed", ["command.actions", "now.track", "now.queue"]],
  ["收藏这首然后下一首", "like", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["重播一次并且收藏", "replay", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["先暂停，十秒后不用自动继续", "pause", "executed", ["command.actions", "now.track"]],
  ["继续，再把后面的歌调柔和些", "resume", "executed", ["command.actions", "now.track", "now.queue"]],
  ["跳过这首，下一首先别太慢", "skip", "executed", ["command.actions", "now.track", "now.queue"]],
  ["今天下午多来点钢琴", "update_session_intent", "executed", ["command.actions", "now.queue", "learningReceipt"]],
  ["今晚都放熟悉一点的", "update_session_intent", "executed", ["command.actions", "now.queue", "learningReceipt"]],
  ["以后多放陈奕迅", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["以后少放现场版", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["不要再放白噪音", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["来点爵士，但不要纯器乐", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["播放王菲的歌，不要《红豆》", "play_specific", "executed", ["command.actions", "now.track"]],
  ["找一首轻快但不吵的中文歌", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["先告诉我队列，再继续播放", "query_queue", "answered", ["command.actions", "now.queue", "now.track"]],
  ["告诉我当前歌曲，然后收藏它", "query_current", "answered", ["command.actions", "now.track", "learningReceipt"]],
  ["跳过，再重播新切到的歌", "skip", "executed", ["command.actions", "now.track"]],
  ["取消收藏后换一首", "unlike", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["来点适合雨夜散步但别太伤的", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["换成凌晨写代码的低频电子", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["下一首必须是女声", "skip", "executed", ["command.actions", "now.track", "now.queue"]],
  ["暂停并且取消这首收藏", "pause", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["播放 Nevada", "play_specific", "executed", ["command.actions", "now.track"]],
  ["切到周杰伦的慢歌", "play_specific", "executed", ["command.actions", "now.track"]],
  ["来点现在天气适合的歌", "play_atmosphere", "executed", ["command.actions", "now.track", "now.decision"]],
  ["只聊聊这首，不要切歌", "noop", "answered", ["command.actions", "now.track"]]
];

const referenceCases = [
  ["收藏当前这首", "like", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["重播刚才那首", "replay", "executed", ["command.actions", "now.track"]],
  ["就刚才第二首", "play_specific", "executed", ["command.actions", "now.track"]],
  ["播放刚才第三首", "play_specific", "executed", ["command.actions", "now.track"]],
  ["后面第三首换到现在", "play_specific", "executed", ["command.actions", "now.track", "now.queue"]],
  ["把队列第一首收藏", "like", "executed", ["command.actions", "now.queue", "learningReceipt"]],
  ["少放当前歌手", "update_long_term_preference", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["当前这个版本有问题", "update_long_term_preference", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["刚才那一版不好，换另一个版本", "play_specific", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["播放 qq:0039MnYb0qxYhV", "play_specific", "executed", ["command.actions", "now.track"]],
  ["收藏 qq:0039MnYb0qxYhV", "like", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["播放队列里的 ncm:347230", "play_specific", "executed", ["command.actions", "now.track", "now.queue"]],
  ["陈奕迅那首", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["播放《后来》", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["来那个 live 版", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["放刚才那首", "play_specific", "executed", ["command.actions", "now.track"]],
  ["后面那首换上来", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["先确认是哪一首，然后收藏第二首", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["不要这个版本，换一个", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["放 Queen 的歌", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["播放 One", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["来一首张三的歌", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["就它", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["换刚才那个歌手的另一首", "play_specific", "executed", ["command.actions", "now.track"]],
  ["把后面第二首删掉，先不要播放", "update_session_intent", "executed", ["command.actions", "now.track", "now.queue"]],
  ["播放我上一次完整听完的歌", "play_specific", "executed", ["command.actions", "now.track"]],
  ["重播前一首，不是当前这首", "replay", "executed", ["command.actions", "now.track"]],
  ["收藏正在播放的 QQ 版本", "like", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["刚才第二首只是现在不合适", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["如果你不确定是哪首就先问我", "noop", "answered", ["command.actions", "now.track"]]
];

const correctionCases = [
  ["不喜欢这首", "unlike", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["少放这个艺人", "update_long_term_preference", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["这首只是现在不合适", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["听腻了", "update_long_term_preference", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["这个版本有问题", "update_long_term_preference", "executed", ["command.actions", "learningReceipt", "now.track"]],
  ["是播放出错，不是我不喜欢", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.track"]],
  ["现在别放摇滚", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["今天不要太伤感", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["接下来两小时只听纯音乐", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["今晚少一点鼓点", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["以后别再放这首", "update_long_term_preference", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["以后多放九十年代华语", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["长期少放说唱", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["以后古典可以多一点", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["我不讨厌这个歌手，只是不喜欢这首", "unlike", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["不是歌的问题，只是现在太吵", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["别因为加载失败就以为我不喜欢", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.track"]],
  ["撤销刚才那条学习", "update_long_term_preference", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["刚才少放这个艺人的设置撤销", "update_long_term_preference", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["确认我就是不喜欢这首", "unlike", "executed", ["command.actions", "learningReceipt"]],
  ["降低自动学到的夜间电子偏好", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["删除自动学到的跑步音乐偏好", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["屏蔽自动推断的白噪音偏好", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["重置自动学习，保留 taste.md", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["这首我会听完，但以后别因此多推", "update_session_intent", "executed", ["command.actions", "learningReceipt"]],
  ["刚才是误触跳过，不要学习", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["刚才再听一遍是因为没听清，不代表喜欢", "update_session_intent", "executed", ["command.actions", "learningReceipt"]],
  ["今天午后古典只要一首", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.queue"]],
  ["以后晚间还是以老歌为主", "update_long_term_preference", "executed", ["command.actions", "learningReceipt"]],
  ["这个偏好只到今天结束", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.queue"]]
];

const contextualCases = [
  ["早上给我一些没听过的新歌", "play_atmosphere", "executed", ["command.actions", "now.track", "now.decision"]],
  ["午后放柔和一点，带两首古典", "play_atmosphere", "executed", ["command.actions", "now.track", "now.queue", "now.decision"]],
  ["晚上放些我长期喜欢的", "play_atmosphere", "executed", ["command.actions", "now.track", "now.decision"]],
  ["下雨天来点适合通勤的", "play_atmosphere", "executed", ["command.actions", "now.track", "now.decision"]],
  ["晴天早晨想要明亮但别太吵", "play_atmosphere", "executed", ["command.actions", "now.track", "now.decision"]],
  ["凌晨写代码，低频一点", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["午睡前来点钢琴", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["开车回家，别放容易困的", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["健身时给我有节奏但不刺耳的", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["做饭的时候来点轻快中文歌", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["周日下午看书，纯器乐优先", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["今天心情低落，但别把我越听越丧", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["现在有点焦虑，放稳定一点的", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["朋友来家里，放不抢聊天的", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["节日晚上想听熟悉但别太俗的", "play_by_description", "executed", ["command.actions", "now.track", "now.decision"]],
  ["根据当前天气和时间安排下一首", "play_atmosphere", "executed", ["command.actions", "now.track", "now.decision"]],
  ["保持当前歌，后面换成专注氛围", "update_session_intent", "executed", ["command.actions", "now.track", "now.queue"]],
  ["立刻切到适合跑步的歌", "update_session_intent", "executed", ["command.actions", "now.track", "now.queue"]],
  ["今天的午后计划柔和一些", "update_session_intent", "executed", ["command.actions", "now.queue", "learningReceipt"]],
  ["今晚计划里加一些回忆感", "update_session_intent", "executed", ["command.actions", "now.queue", "learningReceipt"]],
  ["别动已经听过的歌，只调整后面", "noop", "answered", ["command.actions", "now.track", "now.queue"]],
  ["为什么现在放这首", "query_current", "answered", ["command.actions", "now.track", "now.decision"]],
  ["这首推荐依据是什么", "query_current", "answered", ["command.actions", "now.track", "now.decision"]],
  ["告诉我队列为什么刚换了三首", "query_queue", "answered", ["command.actions", "now.queue"]],
  ["早晨探索不要超过五首", "update_session_intent", "executed", ["command.actions", "now.queue", "learningReceipt"]],
  ["午后古典保持两首", "update_session_intent", "executed", ["command.actions", "now.queue", "learningReceipt"]],
  ["晚间回忆保持八首", "update_session_intent", "executed", ["command.actions", "now.queue", "learningReceipt"]],
  ["候选不够就少放，别拿低质量歌凑", "update_session_intent", "executed", ["command.actions", "now.queue", "learningReceipt"]],
  ["天气变冷了，后面的歌暖一点", "update_session_intent", "executed", ["command.actions", "now.track", "now.queue"]],
  ["我刚连续跳过两首，换个方向但别打断当前", "update_session_intent", "executed", ["command.actions", "now.track", "now.queue"]]
];

const multiSourceCases = [
  ["QQ 那版播不了就换网易云同一录音", "play_specific", "executed", ["command.actions", "now.track"]],
  ["网易云没版权就试 QQ 的同一版本", "play_specific", "executed", ["command.actions", "now.track"]],
  ["不要把 QQ 和网易云同一首排两遍", "query_queue", "answered", ["command.actions", "now.queue"]],
  ["收藏 QQ 版后，两边都记作喜欢这首录音", "like", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["这个 QQ 版本坏了，但别降低我对歌手的偏好", "update_long_term_preference", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["播放失败了，自动严格回退同一录音", "update_session_intent", "executed", ["command.actions", "now.track", "learningReceipt"]],
  ["两个来源标题相近但艺人不同，不要当同一首", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["同名同艺人但时长差一分钟，先问我", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["外部日推的新歌可以进入早晨探索", "play_atmosphere", "executed", ["command.actions", "now.track", "now.decision"]],
  ["QQ 推荐候选不可播放时不要硬塞队列", "query_queue", "answered", ["command.actions", "now.queue"]],
  ["音频加载错误，只冷却这个源版本", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.track"]],
  ["版权错误不等于我跳过", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.track"]],
  ["网络断开导致中止，不要写成不喜欢", "update_session_intent", "executed", ["command.actions", "learningReceipt", "now.track"]],
  ["模型解析失败时不要猜，先问清楚", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["把那个差不多的换掉", "noop", "needs_confirmation", ["command.actions", "clarification"]],
  ["不要播放，只解释你会怎么选", "noop", "answered", ["command.actions", "now.track"]],
  ["播放《Target》后再收藏，收藏失败也别重复播放", "play_specific", "failed", ["command.actions", "now.track"]],
  ["网络重试了同一个命令，不要再切一次", "play_specific", "executed", ["command.actions", "now.track"]],
  ["影子排序出错时继续旧队列", "query_queue", "answered", ["command.actions", "now.queue"]],
  ["人工屏蔽的歌即使 QQ 有也绝不播放", "noop", "answered", ["command.actions", "now.track", "now.queue"]]
];

const highRiskIds = new Set([
  "cmd-009", "cmd-012", "cmd-015", "cmd-016", "cmd-021",
  "cmd-025", "cmd-026", "cmd-029", "cmd-035", "cmd-040",
  "ref-003", "ref-010", "ref-013", "ref-014", "ref-016",
  "ref-019", "ref-030",
  "fix-001", "fix-003", "fix-006", "fix-018",
  "ctx-017", "ctx-021",
  "src-006", "src-017"
]);

const validMusicActions = new Set([
  "skip", "pause", "resume", "replan", "play_specific", "play_by_description", "play_atmosphere",
  "comment_current", "noop", "replay", "like", "unlike", "query_current", "query_queue",
  "update_session_intent", "update_long_term_preference"
]);

const compoundFixtureActions = new Map([
  ["暂停后换一首适合工作的歌", ["pause", "play_by_description"]],
  ["收藏这首然后下一首", ["like", "skip"]],
  ["重播一次并且收藏", ["replay", "like"]],
  ["继续，再把后面的歌调柔和些", ["resume", "update_session_intent"]],
  ["跳过这首，下一首先别太慢", ["skip", "update_session_intent"]],
  ["先告诉我队列，再继续播放", ["query_queue", "resume"]],
  ["告诉我当前歌曲，然后收藏它", ["query_current", "like"]],
  ["跳过，再重播新切到的歌", ["skip", "replay"]],
  ["取消收藏后换一首", ["unlike", "play_by_description"]],
  ["刚才那一版不好，换另一个版本", ["unlike", "play_specific"]],
  ["暂停并且取消这首收藏", ["pause", "unlike"]],
  ["播放《Target》后再收藏，收藏失败也别重复播放", ["play_specific", "like"]]
]);

function buildFixturePlan(input, action, outcome) {
  if (outcome === "needs_confirmation") {
    return Object.freeze({
      actions: Object.freeze([{ action: "noop", confidence: 0.5 }]),
      constraints: Object.freeze([]),
      references: Object.freeze([]),
      confidence: 0.5,
      clarification: Object.freeze({ question: "我找到了多个可信选项，请确认你指的是哪一首。" })
    });
  }
  const fixtureActions = compoundFixtureActions.get(input) ?? [action];
  return Object.freeze({
    actions: Object.freeze(fixtureActions.map((item) => Object.freeze(buildFixtureStep(input, item)))),
    constraints: Object.freeze(input === "下一首必须是女声" ? [{ kind: "tag", value: "女声", hard: true }] : []),
    references: Object.freeze([]),
    confidence: 1
  });
}

function buildFixtureStep(input, action) {
  const base = { action, confidence: 1 };
  if (action === "play_specific") return { ...base, query: fixtureSearchQuery(input), searchQuery: fixtureSearchQuery(input) };
  if (action === "play_by_description") return { ...base, description: input, searchQuery: "offline fixture song" };
  if (action === "replan") return { ...base, desiredMood: "calm" };
  if (action === "update_session_intent") {
    return {
      ...base,
      desiredMood: input,
      scope: /今天|今晚|午后|晚间/u.test(input) ? "day" : "session",
      immediate: /换成|切到|立刻|来点/u.test(input) && !/接下来|后面|保持当前|别打断/u.test(input)
    };
  }
  if (action === "update_long_term_preference") return { ...base, description: input, scope: "long_term" };
  if (action === "like" || action === "unlike" || action === "replay") {
    return { ...base, reference: fixtureReference(input) };
  }
  return base;
}

function fixtureReference(input) {
  if (/队列.*(?:第一|1)/u.test(input)) return { kind: "queue", index: 1 };
  if (/刚才.*第二/u.test(input)) return { kind: "recent", index: 2 };
  if (/qq:/iu.test(input)) return { kind: "track", trackId: "qq:0039MnYb0qxYhV" };
  return { kind: "current" };
}

function fixtureSearchQuery(input) {
  if (/qq:/iu.test(input)) return "qq fixture exact";
  if (/刚才.*第二/u.test(input)) return "Recent Two";
  if (/刚才.*第三/u.test(input)) return "Recent Three";
  if (/队列.*第三/u.test(input)) return "Queue Three";
  return `Fixture ${input}`;
}

function expectedSideEffects(actions) {
  const effects = new Set();
  for (const action of actions) {
    if (["skip", "pause", "resume", "replay", "play_specific", "play_by_description", "play_atmosphere"].includes(action)) {
      effects.add("playback");
    }
    if (["like", "unlike", "update_session_intent", "update_long_term_preference"].includes(action)) {
      effects.add("learning");
    }
    if (["replan", "update_session_intent"].includes(action)) effects.add("queue");
  }
  return [...effects].sort();
}

function buildCategory(prefix, category, cases) {
  return cases.map(([input, action, outcome, seamFields], index) => {
    const id = `${prefix}-${String(index + 1).padStart(3, "0")}`;
    const fixture = buildFixturePlan(input, action, outcome);
    const stepActions = fixture.actions.map((step) => step.action);
    const effectiveAction = stepActions.at(-1) ?? action;
    const effectiveOutcome = outcome === "needs_confirmation" || outcome === "failed"
      ? outcome
      : (["query_current", "query_queue", "noop", "comment_current"].includes(effectiveAction) ? "answered" : "executed");
    const effectiveSeamFields = [...new Set([
      "action",
      ...seamFields.filter((field) => field !== "command.actions"),
      ...(stepActions.length > 1 ? ["command.actions"] : [])
    ])];
    return Object.freeze({
      id,
      category,
      risk: highRiskIds.has(id) ? "high" : "normal",
      fixture,
      text: Object.freeze({
        endpoint: "/api/chat/stream",
        input,
        expected: Object.freeze({
          action: effectiveAction,
          outcome: effectiveOutcome,
          stepActions: Object.freeze(stepActions),
          sideEffects: Object.freeze(expectedSideEffects(stepActions)),
          assertions: Object.freeze(effectiveSeamFields.map((field) => `result.response.${field}`))
        })
      }),
      voice: Object.freeze({
        endpoint: "/api/music/commands",
        input,
        expected: Object.freeze({
          action: effectiveAction,
          outcome: effectiveOutcome,
          stepActions: Object.freeze(stepActions),
          sideEffects: Object.freeze(expectedSideEffects(stepActions)),
          assertions: Object.freeze(effectiveSeamFields.map((field) => {
            const voiceField = field.startsWith("command.") ? field.slice("command.".length) : field;
            return `result.${voiceField}`;
          }))
        })
      })
    });
  });
}

export const intelligenceTrajectories = Object.freeze([
  ...buildCategory("cmd", DIRECT_OR_COMPOUND_COMMAND, commandCases),
  ...buildCategory("ref", REFERENCE_OR_CLARIFICATION, referenceCases),
  ...buildCategory("fix", TEMPORARY_OR_LONG_TERM_CORRECTION, correctionCases),
  ...buildCategory("ctx", CONTEXTUAL_RECOMMENDATION, contextualCases),
  ...buildCategory("src", MULTI_SOURCE_OR_FAILURE, multiSourceCases)
]);

export const highRiskReleaseCases = Object.freeze(
  intelligenceTrajectories.filter((trajectory) => trajectory.risk === "high")
);

const expectedCategorySizes = new Map([
  [DIRECT_OR_COMPOUND_COMMAND, 40],
  [REFERENCE_OR_CLARIFICATION, 30],
  [TEMPORARY_OR_LONG_TERM_CORRECTION, 30],
  [CONTEXTUAL_RECOMMENDATION, 30],
  [MULTI_SOURCE_OR_FAILURE, 20]
]);

for (const [category, expectedSize] of expectedCategorySizes) {
  const actualSize = intelligenceTrajectories.filter((item) => item.category === category).length;
  if (actualSize !== expectedSize) {
    throw new Error(`Invalid intelligence evaluation quota for ${category}: ${actualSize}/${expectedSize}`);
  }
}
for (const trajectory of intelligenceTrajectories) {
  for (const action of trajectory.text.expected.stepActions) {
    if (!validMusicActions.has(action)) throw new Error(`Invalid MusicAction ${action} in ${trajectory.id}`);
  }
}
if (intelligenceTrajectories.length !== 150 || highRiskReleaseCases.length !== 25) {
  throw new Error("Intelligence evaluation corpus must contain 150 trajectories and 25 high-risk cases");
}
