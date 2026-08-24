const QQ_MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";

const QUALITY_FILES = [
  { prefix: "F000", suffix: ".flac" },
  { prefix: "M800", suffix: ".mp3" },
  { prefix: "M500", suffix: ".mp3" },
  { prefix: "C400", suffix: ".m4a" }
] as const;

type QqFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ResolveQqPlaybackInput {
  sourceId: string;
  mediaId?: string;
  cookie?: string;
  fetchImpl?: QqFetch;
}

export async function resolveQqPlayback({
  sourceId,
  mediaId,
  cookie = "",
  fetchImpl = fetch
}: ResolveQqPlaybackInput): Promise<string | undefined> {
  const songMid = sourceId.trim();
  if (!songMid) return undefined;

  const cookieValues = parseCookie(cookie);
  const uin = (cookieValues.uin ?? cookieValues.qqmusic_uin ?? cookieValues.p_uin ?? "0")
    .replace(/^o/u, "");
  const authst = cookieValues.qm_keyst ?? cookieValues.qqmusic_key ?? cookieValues.music_key;
  const mediaIds = [...new Set([mediaId?.trim(), songMid].filter((value): value is string => Boolean(value)))];
  const filenames = mediaIds.flatMap((id) =>
    QUALITY_FILES.map(({ prefix, suffix }) => `${prefix}${id}${suffix}`)
  );
  const guid = String(10_000_000 + Math.floor(Math.random() * 90_000_000));
  const payload = {
    comm: {
      uin,
      format: "json",
      ct: authst ? 19 : 24,
      cv: 0,
      ...(authst ? { authst } : {})
    },
    req_0: {
      module: "vkey.GetVkeyServer",
      method: "CgiGetVkey",
      param: {
        guid,
        songmid: filenames.map(() => songMid),
        songtype: filenames.map(() => 0),
        uin,
        loginflag: 1,
        platform: "20",
        filename: filenames
      }
    }
  };

  const response = await fetchImpl(QQ_MUSICU_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      referer: "https://y.qq.com/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) return undefined;

  const body = await response.json() as QqPlaybackResponse;
  const data = body.req_0?.data;
  const domain = data?.sip?.find((value) => /^https?:\/\//iu.test(value));
  const playable = data?.midurlinfo?.find((value) => typeof value.purl === "string" && value.purl.length > 0);
  if (!domain || !playable?.purl) return undefined;
  return joinPlaybackUrl(domain, playable.purl);
}

interface QqPlaybackResponse {
  req_0?: {
    data?: {
      sip?: string[];
      midurlinfo?: Array<{ purl?: string }>;
    };
  };
}

function parseCookie(cookie: string): Record<string, string> {
  return Object.fromEntries(cookie.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) return [];
    const name = part.slice(0, separator).trim();
    return name ? [[name, part.slice(separator + 1).trim()]] : [];
  }));
}

function joinPlaybackUrl(domain: string, path: string): string {
  if (domain.endsWith("/") && path.startsWith("/")) return `${domain}${path.slice(1)}`;
  if (!domain.endsWith("/") && !path.startsWith("/")) return `${domain}/${path}`;
  return `${domain}${path}`;
}
