import { z } from 'zod';
export const enumGroupsSchema = z.object({version:z.literal(1),groups:z.array(z.object({name:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),values:z.array(z.string()).max(512),label:z.string().max(80).optional(),description:z.string().max(280).optional()}).strict()).max(64)}).strict();
export const classificationOperatorShape = {
  in_group: z.object({schema:z.string().min(1).max(1024),group:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)}).strict().optional(),
  is_unclassified: z.object({schema:z.string().min(1).max(1024)}).strict().optional(),
};
