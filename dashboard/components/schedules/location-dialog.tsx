'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LocateFixed } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { devicesApi, errorMessage } from '@/lib/api';
import { qk } from '@/lib/cache';
import type { DeviceConfig } from '@/lib/types';

const coord = (min: number, max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter the ${what}`)
    .refine((v) => Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max, {
      message: `${what.charAt(0).toUpperCase()}${what.slice(1)} must be between ${min} and ${max}`,
    });

const schema = z.object({
  latitude: coord(-90, 90, 'latitude'),
  longitude: coord(-180, 180, 'longitude'),
});
type Values = z.infer<typeof schema>;

/**
 * Device location for sunrise/sunset schedules (PATCH /devices/:id/settings
 * with latitude+longitude only, so interlock is never touched).
 */
export function LocationDialog({
  deviceId,
  deviceName,
  config,
  open,
  onOpenChange,
}: {
  deviceId: string;
  deviceName: string;
  config: DeviceConfig | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { latitude: '', longitude: '' } });

  useEffect(() => {
    if (!open) return;
    setError(null);
    form.reset({
      latitude: config?.location_set && config.latitude != null ? String(config.latitude) : '',
      longitude: config?.location_set && config.longitude != null ? String(config.longitude) : '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mutation = useMutation({
    mutationFn: (v: Values) => devicesApi.setLocation(deviceId, Number(v.latitude), Number(v.longitude)),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.deviceConfig(deviceId) });
      toast.success(`Location saved for ${deviceName}`);
      onOpenChange(false);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const locate = () => {
    if (!navigator.geolocation) {
      setError("This browser can't share its location — enter the coordinates instead.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        form.setValue('latitude', pos.coords.latitude.toFixed(4), { shouldValidate: true });
        form.setValue('longitude', pos.coords.longitude.toFixed(4), { shouldValidate: true });
      },
      (err) => {
        setLocating(false);
        setError(err.code === err.PERMISSION_DENIED ? 'Location permission was denied.' : "Couldn't get your location.");
      },
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  };

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Device location</DialogTitle>
          <DialogDescription>
            Used to work out sunrise and sunset for {deviceName}. A city-level position is enough.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="grid gap-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="loc-lat">Latitude</Label>
              <Input id="loc-lat" inputMode="decimal" placeholder="e.g. 23.8103" aria-invalid={!!errors.latitude} {...form.register('latitude')} />
              {errors.latitude && <p className="text-xs text-destructive">{errors.latitude.message}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="loc-lng">Longitude</Label>
              <Input id="loc-lng" inputMode="decimal" placeholder="e.g. 90.4125" aria-invalid={!!errors.longitude} {...form.register('longitude')} />
              {errors.longitude && <p className="text-xs text-destructive">{errors.longitude.message}</p>}
            </div>
          </div>
          <Button type="button" variant="outline" onClick={locate} loading={locating} className="justify-self-start">
            {!locating && <LocateFixed />} Use my current location
          </Button>
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Save location
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
