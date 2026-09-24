import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';
import '../../theme/motion.dart';

/// Physical device states rendered by [DeviceVisualization].
enum DeviceVisualState { off, on, connecting, pending, offline, error }

/// A lightweight, layered hardware illustration for the dashboard.
///
/// The illustration deliberately uses transforms, opacity and CustomPainter
/// instead of image assets so rocker movement and indicators remain animated.
class DeviceVisualization extends StatefulWidget {
  const DeviceVisualization({
    super.key,
    required this.state,
    required this.kind,
    this.gangCount = 1,
    this.height = 122,
    this.onTap,
  });

  final DeviceVisualState state;
  final DeviceVisualKind kind;
  final int gangCount;
  final double height;
  final VoidCallback? onTap;

  @override
  State<DeviceVisualization> createState() => _DeviceVisualizationState();
}

class _DeviceVisualizationState extends State<DeviceVisualization>
    with SingleTickerProviderStateMixin {
  bool _pressed = false;

  // Drives the "alive" ON animations (fan spin, light glow pulse). Runs only
  // while an animated kind is ON, so idle tiles cost nothing.
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  );

  bool get _animates =>
      widget.state == DeviceVisualState.on &&
      (widget.kind == DeviceVisualKind.fan ||
          widget.kind == DeviceVisualKind.light ||
          widget.kind == DeviceVisualKind.pump ||
          widget.kind == DeviceVisualKind.motor);

  void _syncPulse() {
    if (_animates) {
      if (!_pulse.isAnimating) _pulse.repeat();
    } else if (_pulse.isAnimating) {
      _pulse.stop();
    }
  }

  @override
  void initState() {
    super.initState();
    _syncPulse();
  }

  @override
  void didUpdateWidget(DeviceVisualization oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncPulse();
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isActive = widget.state == DeviceVisualState.on;
    final isUnavailable = widget.state == DeviceVisualState.offline;
    final isPending =
        widget.state == DeviceVisualState.pending ||
        widget.state == DeviceVisualState.connecting;
    final colorScheme = Theme.of(context).colorScheme;
    final accent = colorScheme.primary;
    final panel = context.panelColors;

    return Semantics(
      button: widget.onTap != null,
      label: '${widget.kind.label}, ${widget.state.label}',
      child: GestureDetector(
        onTapDown: widget.onTap == null
            ? null
            : (_) => setState(() => _pressed = true),
        onTapUp: widget.onTap == null
            ? null
            : (_) {
                setState(() => _pressed = false);
                widget.onTap?.call();
              },
        onTapCancel: widget.onTap == null
            ? null
            : () => setState(() => _pressed = false),
        child: AnimatedScale(
          scale: _pressed ? 0.96 : 1,
          duration: Motion.micro,
          curve: Curves.easeOut,
          child: TweenAnimationBuilder<double>(
            tween: Tween<double>(end: isActive ? 1 : 0),
            duration: Motion.medium,
            curve: Curves.easeOutCubic,
            builder: (context, progress, child) {
              return CustomPaint(
                painter: _DevicePainter(
                  pulse: _pulse,
                  kind: widget.kind,
                  state: widget.state,
                  progress: progress,
                  gangCount: widget.gangCount.clamp(1, 4),
                  accent: accent,
                  pressed: _pressed,
                  panel: panel,
                ),
                child: child,
              );
            },
            child: SizedBox(
              height: widget.height,
              width: double.infinity,
              child: Center(
                child: isPending
                    ? SizedBox(
                        width: 24,
                        height: 24,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: accent,
                        ),
                      )
                    : isUnavailable
                    ? Icon(Icons.wifi_off_rounded, color: accent, size: 22)
                    : null,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

enum DeviceVisualKind {
  switchDevice('Smart switch'),
  plug('Smart plug'),
  socket('Smart socket'),
  light('Smart light'),
  ledStrip('LED strip'),
  fishTank('Fish tank'),
  fan('Fan'),
  multiPlug('Multi-plug'),
  tv('Television'),
  router('Router'),
  pump('Water pump'),
  motor('Motor'),
  appliance('Smart appliance');

  const DeviceVisualKind(this.label);

  final String label;

  static DeviceVisualKind fromName(String name) {
    final value = name.toLowerCase();
    if (value.contains('led') || value.contains('strip')) return ledStrip;
    if (value.contains('fish') ||
        value.contains('tank') ||
        value.contains('aquarium')) {
      return fishTank;
    }
    if (value.contains('pump') || value.contains('water')) return pump;
    if (value.contains('motor')) return motor;
    if (value.contains('fan')) return fan;
    if (value.contains('multi') || value.contains('power strip')) {
      return multiPlug;
    }
    if (value.contains('tv') || value.contains('television')) return tv;
    if (value.contains('router') || value.contains('wifi')) return router;
    if (value.contains('plug')) return plug;
    if (value.contains('socket') || value.contains('outlet')) return socket;
    if (value.contains('light') ||
        value.contains('lamp') ||
        value.contains('bulb')) {
      return light;
    }
    if (value.contains('switch') || value.contains('relay')) {
      return switchDevice;
    }
    return appliance;
  }
}

extension on DeviceVisualState {
  String get label => switch (this) {
    DeviceVisualState.off => 'off',
    DeviceVisualState.on => 'on',
    DeviceVisualState.connecting => 'connecting',
    DeviceVisualState.pending => 'command pending',
    DeviceVisualState.offline => 'offline',
    DeviceVisualState.error => 'error',
  };
}

class _DevicePainter extends CustomPainter {
  _DevicePainter({
    required this.pulse,
    required this.kind,
    required this.state,
    required this.progress,
    required this.gangCount,
    required this.accent,
    required this.pressed,
    required this.panel,
  }) : super(repaint: pulse);

  /// 0..1 repeating value for continuous ON animations; also the repaint
  /// trigger, so frames only redraw while it's running.
  final Animation<double> pulse;
  final DeviceVisualKind kind;
  final DeviceVisualState state;
  final double progress;
  final int gangCount;
  final Color accent;
  final bool pressed;
  final AppPanelColors panel;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final isDimmed =
        state == DeviceVisualState.offline || state == DeviceVisualState.error;
    final opacity = isDimmed ? 0.52 : 1.0;
    final width = math.min(size.width * 0.64, 190.0);
    final plateHeight = width * 0.94;
    final plate = Rect.fromCenter(
      center: center,
      width: width,
      height: plateHeight,
    );

    final shadowPaint = Paint()
      ..color = Colors.black.withValues(alpha: 0.18 * opacity)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 10);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        plate.shift(Offset(0, pressed ? 3 : 6)),
        const Radius.circular(14),
      ),
      shadowPaint,
    );

    final underPlate = RRect.fromRectAndRadius(
      plate.inflate(2),
      const Radius.circular(15),
    );
    canvas.drawRRect(
      underPlate,
      Paint()..color = panel.plateLo.withValues(alpha: 0.72 * opacity),
    );

    final surround = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [Color.lerp(panel.plateHi, panel.plateLo, 0.3)!, panel.plateLo],
      ).createShader(plate)
      ..style = PaintingStyle.fill;
    canvas.drawRRect(
      RRect.fromRectAndRadius(plate, const Radius.circular(13)),
      surround,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(plate, const Radius.circular(13)),
      Paint()
        ..color = panel.hi.withValues(alpha: panel.hi.a * opacity)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2,
    );

    switch (kind) {
      case DeviceVisualKind.switchDevice:
        _paintSwitch(canvas, plate, opacity);
      case DeviceVisualKind.plug:
        _paintPlug(canvas, plate, opacity);
      case DeviceVisualKind.socket:
        _paintSocket(canvas, plate, opacity);
      case DeviceVisualKind.light:
        _paintLight(canvas, plate, opacity);
      case DeviceVisualKind.ledStrip:
        _paintLedStrip(canvas, plate, opacity);
      case DeviceVisualKind.fishTank:
        _paintFishTank(canvas, plate, opacity);
      case DeviceVisualKind.fan:
        _paintFan(canvas, plate, opacity);
      case DeviceVisualKind.multiPlug:
        _paintMultiPlug(canvas, plate, opacity);
      case DeviceVisualKind.tv:
        _paintTv(canvas, plate, opacity);
      case DeviceVisualKind.router:
        _paintRouter(canvas, plate, opacity);
      case DeviceVisualKind.pump:
        _paintPump(canvas, plate, opacity);
      case DeviceVisualKind.motor:
        _paintMotor(canvas, plate, opacity);
      case DeviceVisualKind.appliance:
        _paintAppliance(canvas, plate, opacity);
    }

    if (progress > 0 && kind != DeviceVisualKind.switchDevice) {
      final glow = Paint()
        ..color = accent.withValues(alpha: 0.16 * progress * opacity)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 12);
      canvas.drawRRect(
        RRect.fromRectAndRadius(plate.deflate(5), const Radius.circular(10)),
        glow,
      );
    }
  }

  void _paintSwitch(Canvas canvas, Rect plate, double opacity) {
    final frame = plate.deflate(plate.width * 0.16);
    final gangWidth = frame.width / gangCount;
    final frameShadow = Paint()
      ..color = Colors.black.withValues(alpha: 0.12 * opacity)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        frame.shift(const Offset(0, 2)),
        const Radius.circular(10),
      ),
      frameShadow,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(frame, const Radius.circular(10)),
      Paint()..color = panel.plateLo.withValues(alpha: opacity),
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(frame.deflate(2), const Radius.circular(8)),
      Paint()..color = panel.plateHi,
    );

    // The two fasteners are part of the physical product, not decoration.
    final screwPaint = Paint()
      ..color = panel.screw.withValues(alpha: opacity)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 0.9;
    for (final x in [
      plate.left + plate.width * 0.105,
      plate.right - plate.width * 0.105,
    ]) {
      final screwCenter = Offset(x, plate.center.dy);
      canvas.drawCircle(
        screwCenter,
        4.3,
        Paint()..color = Color.lerp(panel.screw, panel.plateHi, 0.45)!,
      );
      canvas.drawCircle(screwCenter, 4.3, screwPaint);
      canvas.drawLine(
        screwCenter.translate(-1.8, 0),
        screwCenter.translate(1.8, 0),
        screwPaint,
      );
      canvas.drawLine(
        screwCenter.translate(0, -1.8),
        screwCenter.translate(0, 1.8),
        screwPaint,
      );
    }

    for (var i = 0; i < gangCount; i++) {
      final left = frame.left + (i * gangWidth);
      final offRocker = Rect.fromCenter(
        center: Offset(
          left + gangWidth / 2,
          frame.center.dy + frame.height * 0.02,
        ),
        width: gangWidth * 0.58,
        height: frame.height * 0.52,
      );
      final onRocker = Rect.fromLTWH(
        left + gangWidth * 0.09,
        frame.top + frame.height * 0.035,
        gangWidth * 0.82,
        frame.height * 0.91,
      );
      if (i > 0) {
        canvas.drawLine(
          Offset(left, frame.top + 4),
          Offset(left, frame.bottom - 4),
          Paint()
            ..color = panel.plateLo.withValues(alpha: opacity)
            ..strokeWidth = 1,
        );
      }
      final rocker = Rect.lerp(offRocker, onRocker, progress)!;
      final rockerPaint = Paint()
        ..shader = LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            panel.paddleHi,
            Color.lerp(panel.paddle, panel.paddleLo, progress)!,
          ],
        ).createShader(rocker);
      final rockerShadow = rocker.shift(const Offset(0, 3));
      canvas.drawRRect(
        RRect.fromRectAndRadius(rockerShadow, const Radius.circular(6)),
        Paint()..color = panel.sh.withValues(alpha: panel.sh.a * opacity),
      );
      canvas.drawRRect(
        RRect.fromRectAndRadius(rocker, const Radius.circular(6)),
        rockerPaint,
      );
      canvas.drawRRect(
        RRect.fromRectAndRadius(rocker, const Radius.circular(6)),
        Paint()
          ..color = Color.lerp(
            panel.paddleLo,
            panel.screw,
            0.4,
          )!.withValues(alpha: opacity)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.4,
      );
      canvas.drawLine(
        Offset(rocker.left + rocker.width * 0.18, rocker.top + 3),
        Offset(rocker.right - rocker.width * 0.18, rocker.top + 3),
        Paint()
          ..color = panel.hi.withValues(alpha: panel.hi.a * opacity)
          ..strokeWidth = 1,
      );

      final ledOn = progress > 0.5;
      final ledRect = Rect.fromCenter(
        center: Offset(rocker.center.dx, rocker.bottom - rocker.height * 0.09),
        width: math.min(rocker.width * 0.28, 12),
        height: 3,
      );
      canvas.drawRRect(
        RRect.fromRectAndRadius(ledRect, const Radius.circular(2)),
        Paint()
          ..color = ledOn
              ? panel.live.withValues(alpha: opacity)
              : panel.off.withValues(alpha: 0.6 * opacity),
      );
    }
  }

  void _paintPlug(Canvas canvas, Rect plate, double opacity) {
    final center = plate.center;
    final body = RRect.fromRectAndRadius(
      Rect.fromCenter(
        center: center,
        width: plate.width * 0.57,
        height: plate.height * 0.62,
      ),
      const Radius.circular(16),
    );
    canvas.drawRRect(
      body.shift(const Offset(0, 3)),
      Paint()..color = Colors.black.withValues(alpha: 0.13 * opacity),
    );
    canvas.drawRRect(body, Paint()..color = const Color(0xFFFDFDFD));
    canvas.drawRRect(
      body,
      Paint()
        ..color = const Color(0xFFA5AAAA).withValues(alpha: opacity)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
    final outlet = Offset(center.dx, center.dy + body.height * 0.06);
    _paintRoundOutlet(canvas, outlet, body.width * 0.27, opacity);
    final prongPaint = Paint()
      ..color = const Color(0xFFB7A47B).withValues(alpha: opacity);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromCenter(
          center: Offset(body.left + 11, body.center.dy),
          width: 6,
          height: 24,
        ),
        const Radius.circular(3),
      ),
      prongPaint,
    );
    canvas.drawCircle(
      Offset(body.right - 13, body.top + 14),
      3.5,
      Paint()..color = progress > 0.45 ? accent : const Color(0xFF8B8E8E),
    );
  }

  void _paintSocket(Canvas canvas, Rect plate, double opacity) {
    final center = plate.center;
    final body = RRect.fromRectAndRadius(
      Rect.fromCenter(
        center: center,
        width: plate.width * 0.67,
        height: plate.height * 0.7,
      ),
      const Radius.circular(12),
    );
    canvas.drawRRect(body, Paint()..color = const Color(0xFFFDFDFD));
    canvas.drawRRect(
      body,
      Paint()
        ..color = const Color(0xFFA5AAAA).withValues(alpha: opacity)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
    final outletCenter = center.translate(0, 2);
    canvas.drawCircle(
      outletCenter,
      body.width * 0.34,
      Paint()..color = const Color(0xFFB8BDBC).withValues(alpha: opacity),
    );
    canvas.drawCircle(
      outletCenter,
      body.width * 0.31,
      Paint()..color = const Color(0xFFDCE0DF).withValues(alpha: opacity),
    );
    _paintRoundOutlet(canvas, outletCenter, body.width * 0.28, opacity);
    canvas.drawCircle(
      outletCenter,
      5,
      Paint()..color = const Color(0xFF9B8D6B).withValues(alpha: opacity),
    );
    canvas.drawLine(
      outletCenter.translate(-3, -2),
      outletCenter.translate(3, 2),
      Paint()
        ..color = const Color(0xFFF0E4BF).withValues(alpha: opacity)
        ..strokeWidth = 1,
    );
    canvas.drawCircle(
      Offset(body.right - 10, body.top + 12),
      3,
      Paint()..color = progress > 0.45 ? accent : const Color(0xFF8B8E8E),
    );
  }

  void _paintRoundOutlet(
    Canvas canvas,
    Offset center,
    double radius,
    double opacity,
  ) {
    canvas.drawCircle(
      center,
      radius,
      Paint()..color = const Color(0xFF626866).withValues(alpha: opacity),
    );
    canvas.drawCircle(
      center,
      radius * 0.88,
      Paint()..color = const Color(0xFF151A19).withValues(alpha: opacity),
    );
    final hole = Paint()
      ..color = const Color(0xFF050706).withValues(alpha: opacity);
    canvas.drawOval(
      Rect.fromCenter(
        center: center.translate(-radius * 0.37, 0),
        width: radius * 0.18,
        height: radius * 0.48,
      ),
      hole,
    );
    canvas.drawOval(
      Rect.fromCenter(
        center: center.translate(radius * 0.37, 0),
        width: radius * 0.18,
        height: radius * 0.48,
      ),
      hole,
    );
    final ground = Paint()
      ..color = const Color(0xFFC6AE76).withValues(alpha: opacity);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromCenter(
          center: center.translate(0, -radius * 0.6),
          width: radius * 0.16,
          height: radius * 0.32,
        ),
        const Radius.circular(2),
      ),
      ground,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromCenter(
          center: center.translate(0, radius * 0.6),
          width: radius * 0.16,
          height: radius * 0.32,
        ),
        const Radius.circular(2),
      ),
      ground,
    );
  }

  void _paintSocketHoles(
    Canvas canvas,
    Offset center,
    double radius,
    double opacity,
  ) {
    final holePaint = Paint()
      ..color = const Color(0xFF717777).withValues(alpha: opacity);
    canvas.drawOval(
      Rect.fromCenter(
        center: center.translate(-radius * 1.4, -radius * 0.9),
        width: radius,
        height: radius * 2.5,
      ),
      holePaint,
    );
    canvas.drawOval(
      Rect.fromCenter(
        center: center.translate(radius * 1.4, radius * 0.9),
        width: radius,
        height: radius * 2.5,
      ),
      holePaint,
    );
  }

  void _paintLight(Canvas canvas, Rect plate, double opacity) {
    final center = plate.center.translate(0, -5);
    // Warm halo that gently breathes while ON.
    final breath = 0.5 + 0.5 * math.sin(pulse.value * math.pi * 2);
    final glow = Paint()
      ..color = const Color(
        0xFFFFC86B,
      ).withValues(alpha: (0.30 + 0.18 * breath) * progress * opacity)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 16);
    canvas.drawCircle(center, plate.width * (0.19 + 0.03 * breath), glow);
    final bulb = Path()
      ..moveTo(center.dx, center.dy - plate.width * 0.13)
      ..cubicTo(
        center.dx - plate.width * 0.12,
        center.dy - plate.width * 0.13,
        center.dx - plate.width * 0.15,
        center.dy - plate.width * 0.01,
        center.dx - plate.width * 0.07,
        center.dy + plate.width * 0.07,
      )
      ..lineTo(center.dx - plate.width * 0.05, center.dy + plate.width * 0.13)
      ..lineTo(center.dx + plate.width * 0.05, center.dy + plate.width * 0.13)
      ..lineTo(center.dx + plate.width * 0.07, center.dy + plate.width * 0.07)
      ..cubicTo(
        center.dx + plate.width * 0.15,
        center.dy - plate.width * 0.01,
        center.dx + plate.width * 0.12,
        center.dy - plate.width * 0.13,
        center.dx,
        center.dy - plate.width * 0.13,
      )
      ..close();
    canvas.drawPath(
      bulb,
      Paint()
        ..shader =
            RadialGradient(
              colors: [
                Color.lerp(Colors.white, const Color(0xFFFFC86B), progress)!,
                const Color(0xFFE0E5E4),
              ],
            ).createShader(
              Rect.fromCircle(center: center, radius: plate.width * 0.16),
            ),
    );
    final base = Rect.fromCenter(
      center: center.translate(0, plate.width * 0.145),
      width: plate.width * 0.11,
      height: plate.width * 0.07,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(base, const Radius.circular(3)),
      Paint()..color = const Color(0xFF8F9696).withValues(alpha: opacity),
    );
    for (var i = 0; i < 2; i++) {
      final y = base.top + (i * base.height * 0.45) + 2;
      canvas.drawLine(
        Offset(base.left + 2, y),
        Offset(base.right - 2, y),
        Paint()
          ..color = const Color(0xFFE7EBEA).withValues(alpha: opacity)
          ..strokeWidth = 1,
      );
    }
  }

  void _paintLedStrip(Canvas canvas, Rect plate, double opacity) {
    final body = RRect.fromRectAndRadius(
      plate.deflate(plate.width * 0.18),
      const Radius.circular(10),
    );
    canvas.drawRRect(body, Paint()..color = const Color(0xFF2E3839));
    canvas.drawRRect(
      body.deflate(5),
      Paint()
        ..color = progress > 0.45
            ? const Color(0xFFFFC86B).withValues(alpha: opacity)
            : const Color(0xFFB8C1C0).withValues(alpha: opacity),
    );
    for (var i = 0; i < 6; i++) {
      final x = body.left + 13 + i * (body.width - 26) / 5;
      canvas.drawCircle(
        Offset(x, body.center.dy),
        3,
        Paint()
          ..color = progress > 0.45
              ? Colors.white.withValues(alpha: 0.9 * opacity)
              : const Color(0xFF7D8887).withValues(alpha: opacity),
      );
    }
  }

  void _paintFishTank(Canvas canvas, Rect plate, double opacity) {
    final tank = RRect.fromRectAndRadius(
      Rect.fromCenter(
        center: plate.center,
        width: plate.width * 0.62,
        height: plate.height * 0.63,
      ),
      const Radius.circular(7),
    );
    canvas.drawRRect(tank, Paint()..color = const Color(0xFFE8F5F4));
    final water = Rect.fromLTRB(
      tank.left + 2,
      tank.top + tank.height * 0.44,
      tank.right - 2,
      tank.bottom - 2,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(water, const Radius.circular(5)),
      Paint()
        ..color = const Color(0xFF5AAEB5).withValues(alpha: 0.58 * opacity),
    );
    final plant = Paint()
      ..color = const Color(0xFF6E9C70).withValues(alpha: opacity)
      ..strokeWidth = 2.5
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(
      Offset(tank.left + 18, tank.bottom - 5),
      Offset(tank.left + 22, tank.top + 26),
      plant,
    );
    canvas.drawLine(
      Offset(tank.left + 22, tank.top + 30),
      Offset(tank.left + 31, tank.top + 20),
      plant,
    );
    canvas.drawOval(
      Rect.fromCenter(
        center: Offset(tank.right - 22, tank.top + tank.height * 0.58),
        width: 18,
        height: 9,
      ),
      Paint()
        ..color = progress > 0.45
            ? const Color(0xFFFFB36B)
            : const Color(0xFF9DA9A8),
    );
    canvas.drawCircle(
      Offset(tank.right - 13, tank.top + tank.height * 0.58),
      2,
      Paint()..color = const Color(0xFFEAF8F7),
    );
  }

  void _paintFan(Canvas canvas, Rect plate, double opacity) {
    final center = plate.center;
    final radius = plate.height * 0.28;
    canvas.drawCircle(
      center,
      radius + 5,
      Paint()..color = const Color(0xFFEEF2F1),
    );
    canvas.drawCircle(
      center,
      radius + 5,
      Paint()
        ..color = const Color(0xFF9AA3A2).withValues(alpha: opacity)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
    canvas.save();
    canvas.translate(center.dx, center.dy);
    // Settles into a continuous spin while ON (pulse only runs when ON).
    canvas.rotate(progress * math.pi * 0.12 + pulse.value * math.pi * 2);
    final blade = Paint()
      ..color = const Color(0xFFB8C1C0).withValues(alpha: opacity);
    for (var i = 0; i < 4; i++) {
      canvas.rotate(math.pi / 2);
      final path = Path()
        ..moveTo(0, -5)
        ..quadraticBezierTo(
          radius * 0.65,
          -radius * 0.55,
          radius * 0.9,
          -radius * 0.1,
        )
        ..quadraticBezierTo(radius * 0.46, radius * 0.08, 0, 5)
        ..close();
      canvas.drawPath(path, blade);
    }
    canvas.restore();
    canvas.drawCircle(
      center,
      7,
      Paint()..color = progress > 0.45 ? accent : const Color(0xFF828B8A),
    );
  }

  void _paintMultiPlug(Canvas canvas, Rect plate, double opacity) {
    final body = RRect.fromRectAndRadius(
      Rect.fromCenter(
        center: plate.center,
        width: plate.width * 0.68,
        height: plate.height * 0.42,
      ),
      const Radius.circular(10),
    );
    canvas.drawRRect(body, Paint()..color = const Color(0xFFF9FAF9));
    canvas.drawRRect(
      body,
      Paint()
        ..color = const Color(0xFF9FA7A6).withValues(alpha: opacity)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
    for (var i = 0; i < 3; i++) {
      final x = body.left + body.width * (0.2 + i * 0.3);
      _paintSocketHoles(
        canvas,
        Offset(x, body.center.dy),
        plate.width * 0.028,
        opacity,
      );
    }
    canvas.drawCircle(
      Offset(body.right - 11, body.top + 10),
      3,
      Paint()..color = progress > 0.45 ? accent : const Color(0xFF8B9392),
    );
  }

  void _paintTv(Canvas canvas, Rect plate, double opacity) {
    final screen = RRect.fromRectAndRadius(
      Rect.fromCenter(
        center: plate.center.translate(0, -4),
        width: plate.width * 0.7,
        height: plate.height * 0.56,
      ),
      const Radius.circular(5),
    );
    canvas.drawRRect(screen, Paint()..color = const Color(0xFF202A2B));
    canvas.drawRRect(
      screen,
      Paint()
        ..color = const Color(0xFF818B8A).withValues(alpha: opacity)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
    canvas.drawCircle(
      screen.center,
      10,
      Paint()
        ..color = progress > 0.45
            ? const Color(0xFF5AAEB5).withValues(alpha: 0.8)
            : const Color(0xFF394647),
    );
    canvas.drawLine(
      Offset(screen.center.dx, screen.bottom),
      plate.center.translate(0, plate.height * 0.28),
      Paint()
        ..color = const Color(0xFF7E8887)
        ..strokeWidth = 3,
    );
    canvas.drawLine(
      Offset(plate.center.dx - 20, plate.bottom - plate.height * 0.16),
      Offset(plate.center.dx + 20, plate.bottom - plate.height * 0.16),
      Paint()
        ..color = const Color(0xFF7E8887)
        ..strokeWidth = 3,
    );
  }

  void _paintPump(Canvas canvas, Rect plate, double opacity) {
    final isOn = progress > 0.45;
    final center = plate.center.translate(
      -plate.width * 0.06,
      plate.height * 0.07,
    );
    final r = plate.width * 0.19;
    final stroke = Paint()
      ..color = const Color(0xFF9BA4A3).withValues(alpha: opacity)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    final body = Paint()..color = const Color(0xFFF4F7F6);

    // Outlet pipe rising from the volute, then the volute and base.
    final pipe = RRect.fromRectAndRadius(
      Rect.fromLTWH(
        center.dx + r * 0.3,
        center.dy - r * 1.7,
        r * 0.55,
        r * 1.2,
      ),
      const Radius.circular(3),
    );
    canvas.drawRRect(pipe, body);
    canvas.drawRRect(pipe, stroke);
    canvas.drawCircle(center, r, body);
    canvas.drawCircle(center, r, stroke);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromCenter(
          center: Offset(center.dx, center.dy + r + 5),
          width: r * 2.4,
          height: 6,
        ),
        const Radius.circular(3),
      ),
      Paint()..color = const Color(0xFF9BA4A3).withValues(alpha: opacity),
    );

    // Impeller — spins while ON (pulse only runs when ON).
    canvas.save();
    canvas.translate(center.dx, center.dy);
    canvas.rotate(pulse.value * math.pi * 2);
    final vane = Paint()
      ..color = isOn ? accent : const Color(0xFF8B9392)
      ..strokeWidth = 2.4
      ..strokeCap = StrokeCap.round;
    for (var i = 0; i < 5; i++) {
      canvas.rotate(math.pi * 2 / 5);
      canvas.drawLine(Offset.zero, Offset(r * 0.62, 0), vane);
    }
    canvas.restore();
    canvas.drawCircle(
      center,
      3.5,
      Paint()..color = isOn ? accent : const Color(0xFF828B8A),
    );

    // Water drop at the outlet — rises and fades while pumping.
    final dropX = pipe.center.dx;
    final dy = pipe.top - 7 - (isOn ? pulse.value * 6 : 0);
    final drop = Path()
      ..moveTo(dropX, dy - 5)
      ..quadraticBezierTo(dropX + 5, dy + 1, dropX, dy + 4)
      ..quadraticBezierTo(dropX - 5, dy + 1, dropX, dy - 5)
      ..close();
    canvas.drawPath(
      drop,
      Paint()
        ..color = isOn
            ? const Color(
                0xFF4FA3E0,
              ).withValues(alpha: opacity * (1 - pulse.value * 0.6))
            : const Color(0xFFB8C1C0).withValues(alpha: opacity),
    );
  }

  void _paintMotor(Canvas canvas, Rect plate, double opacity) {
    final isOn = progress > 0.45;
    final stroke = Paint()
      ..color = const Color(0xFF9BA4A3).withValues(alpha: opacity)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    final bodyRect = Rect.fromCenter(
      center: plate.center.translate(-plate.width * 0.06, 3),
      width: plate.width * 0.46,
      height: plate.height * 0.32,
    );
    final body = RRect.fromRectAndRadius(bodyRect, const Radius.circular(8));

    // Feet, body, cooling fins.
    final foot = Paint()
      ..color = const Color(0xFF9BA4A3).withValues(alpha: opacity);
    for (final x in [bodyRect.left + 8, bodyRect.right - 20]) {
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, bodyRect.bottom - 1, 12, 6),
          const Radius.circular(2),
        ),
        foot,
      );
    }
    canvas.drawRRect(body, Paint()..color = const Color(0xFFF4F7F6));
    canvas.drawRRect(body, stroke);
    final fin = Paint()
      ..color = const Color(0xFFB8C1C0).withValues(alpha: opacity)
      ..strokeWidth = 1.6;
    for (var i = 1; i <= 4; i++) {
      final x = bodyRect.left + bodyRect.width * i / 5;
      canvas.drawLine(
        Offset(x, bodyRect.top + 5),
        Offset(x, bodyRect.bottom - 5),
        fin,
      );
    }

    // Terminal box with the power LED.
    final box = RRect.fromRectAndRadius(
      Rect.fromCenter(
        center: Offset(bodyRect.center.dx, bodyRect.top - 5),
        width: 18,
        height: 10,
      ),
      const Radius.circular(3),
    );
    canvas.drawRRect(box, Paint()..color = const Color(0xFFF4F7F6));
    canvas.drawRRect(box, stroke);
    canvas.drawCircle(
      box.center,
      2.2,
      Paint()..color = isOn ? accent : const Color(0xFF8B9392),
    );

    // Shaft + spinning rotor end.
    final shaftY = bodyRect.center.dy;
    canvas.drawLine(
      Offset(bodyRect.right, shaftY),
      Offset(bodyRect.right + 14, shaftY),
      Paint()
        ..color = const Color(0xFF7B8584).withValues(alpha: opacity)
        ..strokeWidth = 4
        ..strokeCap = StrokeCap.round,
    );
    final hub = Offset(bodyRect.right + 14, shaftY);
    final hubR = bodyRect.height * 0.3;
    canvas.drawCircle(hub, hubR, Paint()..color = const Color(0xFFF4F7F6));
    canvas.drawCircle(hub, hubR, stroke);
    canvas.save();
    canvas.translate(hub.dx, hub.dy);
    canvas.rotate(pulse.value * math.pi * 2);
    final spoke = Paint()
      ..color = isOn ? accent : const Color(0xFF8B9392)
      ..strokeWidth = 2.2
      ..strokeCap = StrokeCap.round;
    for (var i = 0; i < 3; i++) {
      canvas.rotate(math.pi * 2 / 3);
      canvas.drawLine(Offset.zero, Offset(hubR * 0.8, 0), spoke);
    }
    canvas.restore();
  }

  void _paintRouter(Canvas canvas, Rect plate, double opacity) {
    final body = RRect.fromRectAndRadius(
      Rect.fromCenter(
        center: plate.center.translate(0, 8),
        width: plate.width * 0.62,
        height: plate.height * 0.25,
      ),
      const Radius.circular(8),
    );
    canvas.drawRRect(body, Paint()..color = const Color(0xFFF4F7F6));
    canvas.drawRRect(
      body,
      Paint()
        ..color = const Color(0xFF9BA4A3).withValues(alpha: opacity)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
    for (var i = 0; i < 4; i++) {
      canvas.drawCircle(
        Offset(body.left + 16 + i * 12, body.center.dy),
        2.5,
        Paint()..color = progress > 0.45 ? accent : const Color(0xFF8B9392),
      );
    }
    final antenna = Paint()
      ..color = const Color(0xFF7B8584).withValues(alpha: opacity)
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(
      Offset(body.left + 14, body.top + 2),
      Offset(body.left + 3, body.top - 28),
      antenna,
    );
    canvas.drawLine(
      Offset(body.right - 14, body.top + 2),
      Offset(body.right - 3, body.top - 28),
      antenna,
    );
  }

  void _paintAppliance(Canvas canvas, Rect plate, double opacity) {
    final body = RRect.fromRectAndRadius(
      Rect.fromCenter(
        center: plate.center,
        width: plate.width * 0.52,
        height: plate.height * 0.58,
      ),
      const Radius.circular(12),
    );
    canvas.drawRRect(body, Paint()..color = const Color(0xFFF5F7F6));
    canvas.drawRRect(
      body,
      Paint()
        ..color = const Color(0xFF9BA4A3).withValues(alpha: opacity)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
    canvas.drawCircle(
      Offset(body.center.dx, body.top + 22),
      8,
      Paint()..color = const Color(0xFF8A9392),
    );
    canvas.drawLine(
      Offset(body.left + 15, body.bottom - 20),
      Offset(body.right - 15, body.bottom - 20),
      Paint()
        ..color = progress > 0.45 ? accent : const Color(0xFF9DA5A4)
        ..strokeWidth = 4,
    );
  }

  @override
  bool shouldRepaint(covariant _DevicePainter oldDelegate) =>
      oldDelegate.state != state ||
      oldDelegate.progress != progress ||
      oldDelegate.kind != kind ||
      oldDelegate.gangCount != gangCount ||
      oldDelegate.pressed != pressed;
}
