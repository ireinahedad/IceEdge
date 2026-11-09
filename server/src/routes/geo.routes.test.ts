import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import routes from './geo.routes';
import { geoFromHeaders } from '../services/geo';

const app = express().use('/api/geo', routes);

describe('geoFromHeaders', () => {
  it('New Jersey → eligible, 21+', () => {
    expect(geoFromHeaders({ 'cf-ipcountry': 'US', 'cf-region-code': 'NJ' }, {}))
      .toEqual({ country: 'US', region: 'NJ', sportsbookEligible: true, market: 'US', minAge: 21 });
  });
  it('Kentucky → eligible, 18+', () => {
    expect(geoFromHeaders({ 'cf-ipcountry': 'us', 'cf-region-code': 'ky' }, {}).minAge).toBe(18);
  });
  it('California → not eligible', () => {
    expect(geoFromHeaders({ 'cf-ipcountry': 'US', 'cf-region-code': 'CA' }, {}).sportsbookEligible).toBe(false);
  });
  it('US without region header (transform off) → fails closed', () => {
    const g = geoFromHeaders({ 'cf-ipcountry': 'US' }, {});
    expect(g).toEqual({ country: 'US', region: null, sportsbookEligible: false, market: null, minAge: null });
  });
  it('Ontario → eligible, 19+, market ON', () => {
    expect(geoFromHeaders({ 'cf-ipcountry': 'CA', 'cf-region-code': 'ON' }, {}))
      .toEqual({ country: 'CA', region: 'ON', sportsbookEligible: true, market: 'ON', minAge: 19 });
  });
  it('Québec / other provinces → not eligible', () => {
    for (const r of ['QC', 'BC', 'AB']) {
      expect(geoFromHeaders({ 'cf-ipcountry': 'CA', 'cf-region-code': r }, {}).sportsbookEligible).toBe(false);
    }
  });
  it('Canada without region header → fails closed', () => {
    expect(geoFromHeaders({ 'cf-ipcountry': 'CA' }, {}).sportsbookEligible).toBe(false);
  });
  it('SPORTSBOOK_ONTARIO=false switches Ontario off', () => {
    const g = geoFromHeaders({ 'cf-ipcountry': 'CA', 'cf-region-code': 'ON' }, { SPORTSBOOK_ONTARIO: 'false' });
    expect(g.sportsbookEligible).toBe(false);
    expect(g.market).toBeNull();
  });
  it('a US state code under another country never counts', () => {
    expect(geoFromHeaders({ 'cf-ipcountry': 'CA', 'cf-region-code': 'NJ' }, {}).sportsbookEligible).toBe(false);
  });
  it('Indonesia, Tor, unknown, no headers → not eligible', () => {
    for (const h of [{ 'cf-ipcountry': 'ID' }, { 'cf-ipcountry': 'T1' }, { 'cf-ipcountry': 'XX' }, {}]) {
      expect(geoFromHeaders(h, {}).sportsbookEligible).toBe(false);
    }
  });
  it('SPORTSBOOK_US_STATES overrides the list', () => {
    const env = { SPORTSBOOK_US_STATES: 'ca, tx' };
    expect(geoFromHeaders({ 'cf-ipcountry': 'US', 'cf-region-code': 'CA' }, env).sportsbookEligible).toBe(true);
    expect(geoFromHeaders({ 'cf-ipcountry': 'US', 'cf-region-code': 'NJ' }, env).sportsbookEligible).toBe(false);
  });
});

describe('GET /api/geo', () => {
  it('answers per visitor, never cached', async () => {
    const r = await request(app).get('/api/geo').set('CF-IPCountry', 'US').set('CF-Region-Code', 'NY');
    expect(r.status).toBe(200);
    expect(r.body.sportsbookEligible).toBe(true);
    expect(r.headers['cache-control']).toBe('private, no-store');
  });
});
