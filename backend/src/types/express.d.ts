import { IUser } from '../models/User';

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
      userId?: string;
      sessionId?: string;
    }
  }
}

export {};
