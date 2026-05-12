type Meta = Record<string, unknown>;

const emit = (level: 'info' | 'warn' | 'error', msg: string, meta?: Meta): void => {
  const payload = meta ? { msg, ...meta } : { msg };
  const line = JSON.stringify({ level, time: new Date().toISOString(), ...payload });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
};

export const log = {
  info: (msg: string, meta?: Meta): void => emit('info', msg, meta),
  warn: (msg: string, meta?: Meta): void => emit('warn', msg, meta),
  error: (msg: string, meta?: Meta): void => emit('error', msg, meta),
};
