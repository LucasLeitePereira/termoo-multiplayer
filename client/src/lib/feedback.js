const STATUS_COLOR_MAP = {
  green: "correct",
  yellow: "present",
  gray: "absent",
  correct: "correct",
  present: "present",
  absent: "absent",
  hit: "correct",
  miss: "absent",
  partial: "present",
};

export function normalizeFeedback(feedback, fallbackLength = 5) {
  if (!Array.isArray(feedback)) {
    return new Array(fallbackLength).fill("empty");
  }

  return feedback.map((item) => {
    if (typeof item === "string") {
      return STATUS_COLOR_MAP[item.toLowerCase()] || "absent";
    }

    if (item && typeof item === "object") {
      const status = item.status || item.color || item.result;
      if (typeof status === "string") {
        return STATUS_COLOR_MAP[status.toLowerCase()] || "absent";
      }
    }

    return "absent";
  });
}
