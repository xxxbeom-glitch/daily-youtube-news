const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function kstDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
  };
}

export function getNewsWindow(now = new Date()) {
  const { year, month, day } = kstDateParts(now);

  let endMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  if (now.getTime() < endMs) endMs -= DAY;

  const startMs = endMs - 15 * HOUR;
  const end = new Date(endMs);
  const start = new Date(startMs);

  const playlistDate = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(endMs + HOUR))
    .replace(/\.\s*/g, ".")
    .replace(/\.$/, "");

  return {
    start,
    end,
    playlistDate,
    playlistTitle: `오늘의 뉴스 - ${playlistDate}`,
  };
}
