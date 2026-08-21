from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models.user import User, Role
from app.models.settings import Setting
from app.utils.security import hash_password

def seed_data():
    db: Session = SessionLocal()
    try:
        # Roles
        roles = ["Admin", "QA", "Manager", "Tester"]
        for r in roles:
            if not db.query(Role).filter_by(name=r).first():
                db.add(Role(name=r))
        db.commit()

        # Users (sample)
        samples = [
            {"username": "admin", "email": "admin@example.com", "role": "Admin"},
            {"username": "qa_user", "email": "qa@example.com", "role": "QA"},
            {"username": "manager", "email": "manager@example.com", "role": "Manager"},
            {"username": "tester", "email": "tester@example.com", "role": "Tester"},
        ]
        for s in samples:
            if not db.query(User).filter_by(username=s["username"]).first():
                role = db.query(Role).filter_by(name=s["role"]).first()
                db.add(User(
                    username=s["username"],
                    email=s["email"],
                    role_id=role.id,
                    is_active=True,
                    password_hash=hash_password("my_password") #("Passw0rd!")
                ))
        db.commit()

        # Settings
        if not db.query(Setting).filter_by(key="site_name").first():
            db.add(Setting(key="site_name", value="E2E Spark Assistant"))
        if not db.query(Setting).filter_by(key="session_timeout_minutes").first():
            db.add(Setting(key="session_timeout_minutes", value="60"))
        db.commit()
    finally:
        db.close()