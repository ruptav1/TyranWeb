# Which programs are making sound now: Windows' own meter of each app's sound (Core Audio sessions on
# every speaker / headphones in use), read every 0.7 s. Prints the process ids of the ones heard
# ("12,345"; "" for none) each time that changes. Ends with TyranWeb ($parent).
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class TyranSounds {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumerator {}

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr group, int flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr group, int flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }
  // (IAudioSessionControl's methods first, in their order; only the last ones are called)
  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
    [PreserveSig] int GetGroupingParam(out Guid group);
    [PreserveSig] int SetGroupingParam(IntPtr group, IntPtr context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
  }
  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation {
    [PreserveSig] int GetPeakValue(out float peak);
  }

  // the programs heard above `floor` (0..1), Windows' own sounds left out
  public static string Heard(float floor) {
    var heard = new SortedSet<uint>();
    var devices = (IMMDeviceEnumerator)new DeviceEnumerator();
    IMMDeviceCollection list;
    if (devices.EnumAudioEndpoints(0, 1, out list) != 0) return "";
    int n;
    list.GetCount(out n);
    var iid = typeof(IAudioSessionManager2).GUID;
    for (int d = 0; d < n; d++) {
      IMMDevice device;
      object o;
      if (list.Item(d, out device) != 0 || device.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
      IAudioSessionEnumerator sessions;
      if (((IAudioSessionManager2)o).GetSessionEnumerator(out sessions) != 0) continue;
      int count;
      sessions.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IAudioSessionControl2 s;
        if (sessions.GetSession(i, out s) != 0 || s.IsSystemSoundsSession() == 0) continue;
        uint pid;
        float peak;
        var meter = s as IAudioMeterInformation;
        if (meter == null || s.GetProcessId(out pid) != 0 || pid == 0 || meter.GetPeakValue(out peak) != 0) continue;
        if (peak > floor) heard.Add(pid);
      }
    }
    return string.Join(",", heard);
  }
}
'@
$last = $null
$tick = 0
while ($true) {
  try {
    $now = [TyranSounds]::Heard(0.004)
  } catch {
    $now = ''
  }
  if ($now -ne $last) {
    [Console]::Out.WriteLine($now)
    [Console]::Out.Flush()
    $last = $now
  }
  $tick++
  if ($tick % 7 -eq 0 -and -not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }
  Start-Sleep -Milliseconds 700
}
