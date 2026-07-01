import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { wrap, validated } from './asyncWrap.js';
import { HttpError } from '../tickets.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe('wrap — error funnel', () => {
  it('maps an HttpError to its status with a bare { error } body', async () => {
    const app = makeApp();
    app.get('/x', wrap(async () => { throw new HttpError(418, 'teapot'); }));
    const res = await request(app).get('/x');
    expect(res.status).toBe(418);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(res.body.error).toBe('teapot');
  });

  it('maps an unexpected throw to 500, logs it, and leaks no stack', async () => {
    const app = makeApp();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    app.get('/x', wrap(async () => { throw new Error('boom'); }));
    try {
      const res = await request(app).get('/x');
      expect(res.status).toBe(500);
      expect(Object.keys(res.body)).toEqual(['error']);
      expect(res.body).not.toHaveProperty('stack');
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('captures a SYNCHRONOUS throw, not just a rejected promise', async () => {
    const app = makeApp();
    // fn throws before returning a promise — the `.then(() => fn())` form must
    // still funnel it (a plain Promise.resolve(fn()) would leak this).
    app.get('/x', wrap(() => { throw new HttpError(400, 'sync'); }));
    const res = await request(app).get('/x');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sync');
  });

  it('reports a non-Error throw as 500 "Unknown error"', async () => {
    const app = makeApp();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    app.get('/x', wrap(async () => { throw 'a bare string'; }));
    try {
      const res = await request(app).get('/x');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Unknown error');
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('validated — parse then inject', () => {
  const schema = z.object({ name: z.string().min(1, 'name is required') });

  it('parses the body and injects the typed value as the third arg', async () => {
    const app = makeApp();
    app.post('/x', validated(schema, async (_req, res, input) => { res.json({ echo: input.name }); }));
    const res = await request(app).post('/x').send({ name: 'jake' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ echo: 'jake' });
  });

  it('rejects an invalid body with 400 before the handler runs', async () => {
    const app = makeApp();
    let handlerRan = false;
    app.post('/x', validated(schema, async (_req, res) => { handlerRan = true; res.json({ ok: true }); }));
    // Empty string trips the .min(1) check (custom message); the handler must
    // never run because the ZodError funnels to a 400 before it.
    const res = await request(app).post('/x').send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name is required');
    expect(handlerRan).toBe(false);
  });
});
