import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = new TextEncoder().encode(secret);

export async function getUserIdFromToken(): Promise<string | null> {
    const token = (await cookies()).get('authToken')?.value;
    if (!token) return null;
    try {
        const { payload } = await jwtVerify(token, JWT_SECRET);
        return typeof payload.id === 'string' ? payload.id : null;
    } catch {
        return null;
    }
}