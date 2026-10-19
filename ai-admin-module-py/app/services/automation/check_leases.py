"""Database leases prevent two backend workers replaying the same AI batch."""
from datetime import datetime, timedelta
from uuid import uuid4
from sqlalchemy.exc import IntegrityError
from ...database.connection import SessionLocal
from ...models.automation import AutomationAICheckLease as Lease

TTL = 120


def acquire(batch_id):
    owner = uuid4().hex
    now = datetime.utcnow()
    with SessionLocal() as db:
        updated = db.query(Lease).filter(Lease.batch_id == batch_id, Lease.expires_at < now).update(
            {Lease.owner: owner, Lease.expires_at: now + timedelta(seconds=TTL)})
        if not updated:
            db.add(Lease(batch_id=batch_id, owner=owner, expires_at=now + timedelta(seconds=TTL)))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return None
    return owner


def renew(batch_id, owner):
    with SessionLocal() as db:
        changed = db.query(Lease).filter(Lease.batch_id == batch_id, Lease.owner == owner).update(
            {Lease.expires_at: datetime.utcnow() + timedelta(seconds=TTL)})
        db.commit()
        return bool(changed)


def release(batch_id, owner):
    with SessionLocal() as db:
        db.query(Lease).filter(Lease.batch_id == batch_id, Lease.owner == owner).delete()
        db.commit()


def active(batch_id):
    with SessionLocal() as db:
        return db.query(Lease.batch_id).filter(Lease.batch_id == batch_id, Lease.expires_at >= datetime.utcnow()).first() is not None
