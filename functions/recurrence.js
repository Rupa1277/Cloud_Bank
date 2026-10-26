function nextOccurrence(currentAt, order) {
  const current = new Date(currentAt);
  if (!Number.isFinite(current.getTime())) throw new TypeError('currentAt must be a valid date');

  if (order.frequency === 'MONTHLY') {
    const year = current.getUTCFullYear();
    const month = current.getUTCMonth() + 1;
    const anchorDay = Number.isInteger(order.scheduleDayOfMonth)
      ? order.scheduleDayOfMonth
      : current.getUTCDate();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(
      year, month, Math.min(anchorDay, lastDay),
      current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds(), current.getUTCMilliseconds(),
    ));
  }

  const intervalDays = order.frequency === 'DAILY' ? 1
    : order.frequency === 'WEEKLY' ? 7
      : order.intervalDays;
  if (!Number.isInteger(intervalDays) || intervalDays <= 0) {
    throw new TypeError('order must define a valid frequency or intervalDays');
  }
  return new Date(current.getTime() + intervalDays * 86400000);
}

module.exports = { nextOccurrence };
