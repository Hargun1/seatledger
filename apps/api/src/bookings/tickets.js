import { createHmac,timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { withAuthorizedSession } from '../auth/authorized-transaction.js';
import { sessionCookie,browserMutation,verifyCsrf } from '../auth/security.js';
import { reservationId,parseReservationValue as parse } from '../reservations/commands.js';
import { lockShowGate,lockShowSeats } from '../reservations/service.js';
import { HttpError } from '../http-error.js';

function key(secret){if(typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))throw new TypeError('Invalid ticket configuration');return createHmac('sha256',Buffer.from(secret,'hex')).update('seatledger:admission:key:v1').digest();}
export function ticketCredential(id,secret){if(!z.uuid().safeParse(id).success||id!==id.toLowerCase())throw new TypeError('Invalid ticket identity');return 'sl1.'+id+'.'+createHmac('sha256',key(secret)).update('seatledger:admission:ticket:v1:'+id).digest('base64url');}
export function verifyTicketCredential(value,secret){
  if(typeof value!=='string'||!/^sl1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(value))return null;
  const id=value.split('.')[1];if(!z.uuid().safeParse(id).success)return null;
  const expected=ticketCredential(id,secret);return timingSafeEqual(Buffer.from(value),Buffer.from(expected))?id:null;
}
const stamp=c=>`to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// This is a database-only operation. Caller owns the authorization transaction.
export async function issueTickets(db,userId,bookingId){
  const initial=(await db.query('SELECT reservation_id,show_id FROM bookings WHERE id=$1 AND user_id=$2',[bookingId,userId])).rows[0];
  if(!initial)throw new HttpError(404,'NOT_FOUND');
  await lockShowGate(db,initial.show_id,false);
  const items=(await db.query('SELECT id,venue_seat_id FROM booking_items WHERE booking_id=$1 ORDER BY venue_seat_id',[bookingId])).rows;
  if(items.length<1||items.length>8)throw new HttpError(409,'TICKETS_UNAVAILABLE');
  await lockShowSeats(db,initial.show_id,items.map(i=>i.venue_seat_id));
  await db.query('SELECT id FROM reservations WHERE id=$1 FOR UPDATE',[initial.reservation_id]);
  await db.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE',[bookingId]);
  await db.query('SELECT id FROM payment_attempts WHERE booking_id=$1 ORDER BY id FOR UPDATE',[bookingId]);
  async function eligible(){return (await db.query(`SELECT b.status='CONFIRMED' AND b.sealed_at IS NOT NULL AND r.status='CONFIRMED'
    AND s.status='SCHEDULED' AND s.starts_at>clock_timestamp() AND e.status<>'CANCELLED'
    AND EXISTS(SELECT 1 FROM payment_attempts p WHERE p.booking_id=b.id AND p.status='SUCCEEDED' AND p.resolution='BOOKED')
    AND NOT EXISTS(SELECT 1 FROM ticket_checkins c JOIN booking_items i ON i.id=c.booking_item_id WHERE i.booking_id=b.id)
    AND NOT EXISTS(SELECT 1 FROM booking_items i LEFT JOIN show_seats stock ON stock.show_id=i.show_id AND stock.venue_seat_id=i.venue_seat_id
      WHERE i.booking_id=b.id AND (stock.state IS DISTINCT FROM 'BOOKED' OR stock.booking_id IS DISTINCT FROM b.id OR stock.reservation_id IS DISTINCT FROM b.reservation_id)) AS valid
    FROM bookings b JOIN reservations r ON r.id=b.reservation_id JOIN shows s ON s.id=b.show_id JOIN events e ON e.id=s.event_id WHERE b.id=$1 AND b.user_id=$2`,[bookingId,userId])).rows[0]?.valid;}
  if(!await eligible())throw new HttpError(409,'TICKETS_UNAVAILABLE');
  await db.query(`INSERT INTO admission_tickets(booking_item_id,booking_id,show_id,issued_by)
    SELECT id,booking_id,show_id,$2 FROM booking_items WHERE booking_id=$1 ORDER BY venue_seat_id ON CONFLICT(booking_item_id) DO NOTHING`,[bookingId,userId]);
  const count=(await db.query('SELECT count(*)::int AS n FROM admission_tickets WHERE booking_id=$1',[bookingId])).rows[0].n;
  if(count!==items.length)throw new Error('Incomplete ticket set');
  if(!await eligible())throw new HttpError(409,'TICKETS_UNAVAILABLE');
  return {bookingId,issued:true,paymentMode:'simulated'};
}
export async function readTickets(db,userId,bookingId,secret){
  const row=(await db.query(`SELECT b.id,s.id AS show_id FROM bookings b JOIN shows s ON s.id=b.show_id WHERE b.id=$1 AND b.user_id=$2 AND b.sealed_at IS NOT NULL`,[bookingId,userId])).rows[0];
  if(!row)throw new HttpError(404,'NOT_FOUND');
  const tickets=(await db.query(`SELECT t.id,i.venue_seat_id AS "seatId",i.section_name AS section,i.row_label AS row,i.seat_number AS number,${stamp('t.issued_at')} AS "issuedAt",
    CASE WHEN b.status<>'CONFIRMED' OR r.status<>'CONFIRMED' OR s.status<>'SCHEDULED' OR e.status='CANCELLED'
      OR stock.state IS DISTINCT FROM 'BOOKED' OR stock.booking_id IS DISTINCT FROM b.id OR stock.reservation_id IS DISTINCT FROM b.reservation_id
      OR NOT EXISTS(SELECT 1 FROM payment_attempts p WHERE p.booking_id=b.id AND p.status='SUCCEEDED' AND p.resolution='BOOKED') THEN 'VOID'
      WHEN EXISTS(SELECT 1 FROM ticket_checkins c WHERE c.booking_item_id=i.id) THEN 'USED'
      WHEN s.starts_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'ISSUED' END AS status
    FROM admission_tickets t JOIN bookings b ON b.id=t.booking_id JOIN reservations r ON r.id=b.reservation_id JOIN shows s ON s.id=b.show_id JOIN events e ON e.id=s.event_id
    JOIN booking_items i ON i.id=t.booking_item_id LEFT JOIN show_seats stock ON stock.show_id=i.show_id AND stock.venue_seat_id=i.venue_seat_id
    WHERE t.booking_id=$1 AND b.user_id=$2 ORDER BY i.venue_seat_id`,[bookingId,userId])).rows;
  return {bookingId,showId:row.show_id,paymentMode:'simulated',tickets:tickets.map(t=>({...t,credential:t.status==='ISSUED'?ticketCredential(t.id,secret):null}))};
}
export function createTicketRouter({pool,config}){
  const router=Router(),empty=z.object({}).strict();
  router.use('/bookings/:id/tickets',(req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');next();});
  router.get('/bookings/:id/tickets',async(req,res)=>{const result=await withAuthorizedSession(pool,config,sessionCookie(req,config),async(db,session)=>{parse(empty,req.query);return readTickets(db,session.user.id,parse(reservationId,req.params.id,true),config.AUTH_SECRET);});res.json(result);});
  router.post('/bookings/:id/tickets',browserMutation(config),async(req,res)=>{const result=await withAuthorizedSession(pool,config,sessionCookie(req,config),async(db,session)=>{verifyCsrf(req,session);parse(empty,req.query);parse(empty,req.body);return issueTickets(db,session.user.id,parse(reservationId,req.params.id,true));});res.status(200).json(result);});
  return router;
}
