function currentZonedIso(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const offset = (value('timeZoneName') || 'GMT+00:00').replace('GMT', '') || '+00:00';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}${offset}`;
}

function formatTimestamp(timestamp, timeZone) {
  return new Intl.DateTimeFormat('en-PK', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

module.exports = { currentZonedIso, formatTimestamp };
