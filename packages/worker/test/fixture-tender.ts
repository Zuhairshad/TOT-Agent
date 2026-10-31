import type { ExtractedTender } from '../src/extracted.js';

export function makeItems(n: number): ExtractedTender['items'] {
  return Array.from({ length: n }, (_, i) => ({
    lineNo: i + 1,
    description:
      i % 7 === 3
        ? `Heavy duty motorcycle model ${i + 1} with reinforced rear carrier, ${'extended description text '.repeat(6)}Supercalifragilisticexpialidocious_${'x'.repeat(60)}`
        : `Motorcycle 150cc, type ${i + 1}`,
    specification: i % 2 === 0 ? 'Engine 150cc, 4-stroke, air cooled, disc brake front' : null,
    unit: 'pcs',
    quantity: i % 5 === 0 ? '1,250' : (i + 1) * 10,
  }));
}

export const FIXTURE: ExtractedTender = {
  tenderTitle:
    'Supply and delivery of 200 motorcycles and spare parts for community health workers in Nairobi County and surrounding districts',
  purchaser: 'Ministry of Health, Republic of Kenya — Department of Supplies',
  referenceNo: 'MOH/ONT/2026/017',
  submissionDeadline: '2026-12-01 12:00',
  bidSecurity: 'KES 500,000 in the form of a bank guarantee valid for 120 days',
  deliveryLocation: 'Nairobi Central Stores, Industrial Area',
  deliveryPeriod: '90 days from contract signature',
  eligibility: [
    'Registered company with at least 5 years of experience in supplying vehicles',
    'Valid tax compliance certificate and business permit',
    'Manufacturer authorisation for the offered models (café “quoted” • مرحبا 中文)',
  ],
  items: [
    {
      lineNo: 1,
      description: 'Motorcycle 150cc – Supply of مرحبا 中文 models',
      specification: 'Engine 150cc, 4-stroke',
      unit: 'pcs',
      quantity: 200,
    },
    {
      lineNo: 2,
      description: 'Spare parts kit',
      specification: null,
      unit: 'sets',
      quantity: '40',
    },
  ],
  estimatedValue: 'USD 180,000',
  notes: 'Site visit on 2026-11-10. Clarifications close 7 days before the deadline.',
  missing: ['Payment terms', 'items[1].specification'],
};
