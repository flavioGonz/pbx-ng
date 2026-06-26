'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export default function Redir() { const r = useRouter(); useEffect(() => { r.replace('/rutas'); }, [r]); return null; }
