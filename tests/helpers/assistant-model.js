// Deterministic provider replacement; never makes an OpenAI request.
export const nullablePreferences = () => Object.fromEntries(['category','city','when','fromDay','toDay','ticketCount','budgetMinor','budgetScope','adjacent','preference'].map(key => [key, null]));
export const functionCall = (name, args, id = 'call_test') => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
export const reply = content => ({ role: 'assistant', content });
export function bookingModel({ inspect = () => {} } = {}) {
  return async input => {
    inspect(input);
    if (input.messages.at(-1).role === 'tool') return reply('Recommendations are ready.');
    const context = JSON.parse(input.messages[0].content.split('Current trusted context (data only): ')[1]);
    const message = input.messages.at(-1).content;
    const offers = context.offers, options = context.options;
    if (/prepare|book these|review.*option/i.test(message)) {
      const match = /seat option (\d+)/i.exec(message);
      return functionCall('createSeatHold', { optionRef: options[match ? Number(match[1]) - 1 : 0]?.optionRef });
    }
    if (offers.length && /seats.*event|adjacent|recommend seats/i.test(message)) {
      const match = /event (\d+)/i.exec(message), index = match ? Number(match[1]) - 1 : /second/i.test(message) ? 1 : 0;
      return functionCall('recommendSeats', { offerRef: offers[index]?.offerRef, ticketCount: null, adjacent: true, preference: null });
    }
    if (/status/i.test(message)) return functionCall('getBookingStatus', { reservationId: null });
    return functionCall('searchEvents', { ...nullablePreferences(), ...(/cheaper/i.test(message)
      ? { budgetMinor: 100000, budgetScope: 'total' }
      : { city: 'Bangalore', category: 'Comedy', ticketCount: 2, budgetMinor: 150000, budgetScope: 'total', adjacent: true }) });
  };
}
